# Audio-Werkzeuge – Predigt-Schnitt & Termine

Zwei Apps unter einer Startseite:

- **Predigt-Schnitt** (`apps/predigt-schnitt/`) – siehe unten.
- **Termine** (`apps/termine/`) – Liste der kommenden Sonntage; jede Person sagt mit ihrem Kürzel (z. B. `JD`)
  Ja / Vielleicht / Nein. Alle sehen, wer was geantwortet hat und wer noch offen ist. Pro Termin lassen sich
  Anlass, Uhrzeit, Einteilung und Hinweise eintragen; sagt eine eingeteilte Person ab, wird das markiert.
  Siehe [Termine einrichten](#termine-einrichten).

Predigt-Schnitt: Browser-App, die eine Gottesdienst-Aufnahme (MP3) lädt, die Predigt automatisch erkennt,
die Lautheit normalisiert, als MP3 exportiert und auf den Zielserver hochlädt.
Alles läuft im Browser; das Audio verlässt den Rechner erst beim Upload.
Umsetzung von [Planung_Predigt-Schnitt-WebApp.md](Planung_Predigt-Schnitt-WebApp.md).

Anmeldung: Benutzer `mischer`, Passwort `mischer` (bleibt im Browser gespeichert, „Abmelden“ oben rechts).
Das ist eine Komfort-Sperre, kein echter Zugriffsschutz – die Zugangsdaten stehen im ausgelieferten JavaScript.
Geschützt sind die Uploads durch das Token im Server-Skript.

## Lokal starten

```sh
npm install
npm run dev          # http://localhost:5173 – auch im LAN erreichbar (Tablet-Test)
```

Im Dev-Server ist ein Test-Upload-Ziel eingebaut (`/api/upload`, Token `dev-token`, Profil
„Lokaler Test-Server“). Hochgeladene Dateien landen in `uploads-dev/`.
Ebenso ein Test-Speicher für die Termine-App (`/api/termine`, Token `dev-token`, Daten in `uploads-dev/termine.json`).

```sh
npm run build        # Produktions-Build nach dist/
npm run preview      # dist/ lokal ausliefern (http://localhost:4173, mit Test-Upload)
npm test             # Unit-Tests (Vitest)
```

### Server selbst testen

Der „Server“ ist der Vite-Dev-Server mit den eingebauten Test-Endpunkten aus [dev-server.ts](dev-server.ts)
(Ersatz für `server/upload.php` und `server/termine.php`). Es gibt kein separates Backend zu starten.

1. **Starten:** `npm install` (einmalig), dann `npm run dev`. Die Ausgabe nennt `Local:` (`http://localhost:5173`)
   und `Network:` (für das Tablet im selben WLAN). Beenden mit `Strg+C`.
   Meldet Vite `Port 5173 is already in use`, läuft bereits ein Dev-Server – diesen weiterverwenden oder
   mit `npm run dev -- --port 5174` einen zweiten starten.
2. **Im Browser:** `http://localhost:5173` öffnen, mit `mischer` / `mischer` anmelden. Für den Upload unter
   *Einstellungen → Upload-Ziele* das Profil „Lokaler Test-Server“ wählen (URL `/api/upload`, Token `dev-token`);
   bei Termine URL `/api/termine` und Token `dev-token`.
3. **Endpunkte per `curl` prüfen** (in einem zweiten Terminal; `B` ggf. an den Port anpassen):

   ```sh
   B=http://localhost:5173
   printf 'ID3\x03\x00\x00\x00\x00\x00\x00fake' > test.mp3      # Minimal-"MP3" mit ID3-Kopf

   # Upload (Header X-Upload-Token, Feld "file")
   curl -i -X POST $B/api/upload -F file=@test.mp3                                  # 401 (kein Token)
   curl -i -X POST $B/api/upload -H 'X-Upload-Token: dev-token' -F file=@test.mp3   # 200 {"ok":true,...}
   curl -i -X POST $B/api/upload -H 'X-Upload-Token: dev-token' -F file=@test.mp3   # 409 (gibt es schon)

   # Termine (Header X-Termine-Token, JSON-Operationen "vote" und "update")
   H='X-Termine-Token: dev-token'
   curl -X POST $B/api/termine -H "$H" -H 'Content-Type: application/json' \
        -d '{"action":"vote","date":"2030-01-06","sign":"JD","answer":"yes"}'
   curl -H "$H" $B/api/termine                                                      # alle Termine als JSON
   ```

   Erwartete Statuscodes wie bei den PHP-Skripten: `401` falsches/fehlendes Token, `400` ungültiger Name bzw.
   Kürzel, `409` Datei existiert schon, `413` zu groß (80 MB), `415` keine MP3, `405` falsche Methode.
4. **Ergebnis ansehen:** Uploads liegen in `uploads-dev/`, die Termine in `uploads-dev/termine.json`.
   Zum Zurücksetzen die Dateien dort löschen (der Ordner ist in `.gitignore`).
5. **Tests:** `npm test` prüft Namensschema, Termine-Datenmodell und Audio-Erkennung (läuft ohne Server).
   Der Produktions-Build wird mit `npm run build && npm run preview` (Port 4173) auf dieselbe Weise getestet.

Die echten PHP-Skripte laufen nicht im Dev-Server. Wer sie lokal ausprobieren will (PHP muss installiert sein), kann
`php -S localhost:8000 -t server` verwenden, in den Skripten Token und `TARGET_DIR` setzen und in der App
`http://localhost:8000/upload.php` bzw. `termine.php` eintragen (nicht getestet; `localhost:5173` steht bereits in `ALLOWED_ORIGINS`).

## Ablauf in der App

1. **Laden** – MP3 hineinziehen. Die Datei wird einmal komplett dekodiert (Web Worker, mpg123/WASM):
   Wellenform-Peaks, Merkmale für die Erkennung und ein Frame-Index für exaktes Springen.
2. **Schnitt** – Vorschlag für Start/Ende als orange Region; Übersicht mit Sprache/Musik/Stille,
   Alternativ-Vorschläge, Vorhören, Feinjustieren (Tastatur: Leertaste, S/E, ←/→, Umschalt, P).
3. **Lautheit** – Messung nach EBU R128 (BS.1770), Anhebung auf Ziel (Standard −19 LUFS mono),
   Look-ahead-Limiter, optional Hochpass 80 Hz und sanfte Kompression.
4. **Export** – MP3 (LAME/WASM, CBR), ID3-Tags, Dateiname nach Schema `predigt_eag_{datum}`.
   Die angezeigte Lautheit wird am fertigen MP3 gemessen.
5. **Upload** – per HTTP an `server/upload.php` mit Fortschritt; alternativ Herunterladen.

## Zielserver einrichten (Upload)

> **Vorläufig zurückgestellt:** Wie die Predigten auf den Zielserver bzw. in den Podcast-Feed kommen,
> ist noch nicht geklärt. Bis dahin ist **Herunterladen** der Normalweg; das PHP-Skript unten ist ein
> getesteter Vorschlag für den Fall, dass der Webspace PHP kann.

Browser können kein FTP. Deshalb nimmt ein kleines PHP-Skript die Datei per HTTP an:

1. `server/upload.php` auf den Webspace kopieren, darin `UPLOAD_TOKEN` (lang, zufällig, z. B.
   `openssl rand -hex 24`), `ALLOWED_ORIGINS` (z. B. `https://NAME.github.io`) und `TARGET_DIR` setzen.
2. `server/predigten.htaccess` als `.htaccess` in den Zielordner legen (keine Skriptausführung).
3. Bei kleinen Upload-Grenzen `server/user.ini` als `.user.ini` neben das Skript legen.
4. In der App unter **Einstellungen → Upload-Ziele** URL und Token eintragen.

Das Skript lehnt falsche Tokens (401), ungültige Namen (400), Nicht-MP3 (415), zu große Dateien (413)
und bereits vorhandene Dateien (409) ab; die App zeigt dafür verständliche Meldungen.

## Termine einrichten

Die Antworten müssen für alle sichtbar sein, also braucht es einen gemeinsamen Speicher.
Das übernimmt `server/termine.php` (eine JSON-Datei, gesperrt beim Schreiben, damit gleichzeitige Antworten nicht verloren gehen):

1. `server/termine.php` auf den Webspace kopieren, darin `TERMINE_TOKEN` (lang, zufällig) und `ALLOWED_ORIGINS` setzen.
   Die Daten landen in `termine-daten/termine.json` neben dem Skript; das Skript legt dort eine `.htaccess` mit
   `Require all denied` an (bei nginx den Ordner in der Server-Konfiguration sperren).
2. In der App unter **⚙ Einstellungen** URL und Token eintragen (an alle Mischer weitergeben).
3. Jede Person trägt oben ihr Kürzel ein; es bleibt im Browser gespeichert.

Jeder mit Token kann alle Termine bearbeiten und unter jedem Kürzel antworten – gedacht für ein kleines, vertrautes Team.
Angezeigt werden die nächsten 12 Sonntage (einstellbar), ältere per „Ältere anzeigen“; „+ Weiterer Termin“ legt
einen Termin an einem anderen Tag an (z. B. Karfreitag). Die Liste aktualisiert sich jede Minute.

## Veröffentlichen auf GitHub Pages

Repo anlegen, pushen, unter *Settings → Pages → Source: GitHub Actions* wählen.
`.github/workflows/deploy.yml` testet, baut und veröffentlicht bei jedem Push auf `main`.
Der Build nutzt relative Pfade und läuft daher unter jedem Unterpfad (`NAME.github.io/audio-tools/`).

## Erkennung prüfen und kalibrieren

Siehe [testdata/README.md](testdata/README.md). Kurz:

```sh
npm run bench -- pfad/zur/aufnahme.mp3    # Vorschlag für einzelne Dateien
npm run bench                              # alle Dateien aus testdata/markers.json mit Abweichungstabelle
npm run bench -- --csv --render            # + Merkmale als CSV, + Export und LUFS-Vergleich mit ffmpeg
```

`python3 scripts/make-synthetic.py` erzeugt eine synthetische Testaufnahme (espeak-ng + Orgel-Synthese),
falls gerade keine echte zur Hand ist.

## Aufbau

```
index.html, src/home.ts      Startseite mit Kacheln aus apps.json
apps/predigt-schnitt/        Predigt-Schnitt (Schritte unter src/steps/)
apps/termine/                Termine (src/model.ts: Datenmodell, auch vom Dev-Server genutzt)
packages/audio-core/         Decoder, Frame-Index, Merkmale, Erkennung, Lautheit, DSP, Pipeline, Worker
packages/upload/             HTTP-Upload mit Fortschritt
packages/settings/           localStorage-Store mit JSON-Export/-Import
packages/auth/               Login-Sperre
packages/ui-kit/             DOM-Helfer, Styles
server/                      upload.php, termine.php und Vorlagen für den Zielserver (nicht Teil des Builds)
scripts/                     bench.ts (Erkennungs-Benchmark), make-synthetic.py
dev-server.ts                Test-Endpunkte (Upload, Termine) für dev/preview
```

Neue App: Ordner unter `apps/`, Eintrag in `apps.json` und in `vite.config.ts` (`rollupOptions.input`).

## Bekannte Grenzen / noch offen

- Die Erkennungs-Schwellen sind Startwerte (Phase 5 des Plans); sie müssen mit echten Aufnahmen kalibriert werden.
- Transkript-Verfeinerung (Whisper), PWA/Offline und Stapelverarbeitung sind noch nicht umgesetzt (Phase 7).
- Der Export wird immer mit 44,1 kHz kodiert (48-kHz-Quellen resampelt LAME).
- Die Beispiel-Dateien (`predigt-beispiele.zip`) sind bereits geschnittene Predigten; zum Kalibrieren der
  Erkennung werden die vollständigen Gottesdienst-Mitschnitte gebraucht.
