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
Ebenso ein Test-Cloud-Ordner für die Termine-App (WebDAV-Nachbau unter `/dav/public-files/dev-token/`, Passwort `dev-token`,
Datei in `uploads-dev/termine.xlsx`).

```sh
npm run build        # Produktions-Build nach dist/
npm run preview      # dist/ lokal ausliefern (http://localhost:4173, mit Test-Upload)
npm test             # Unit-Tests (Vitest)
```

### Server selbst testen

Der „Server“ ist der Vite-Dev-Server mit den eingebauten Test-Endpunkten aus [dev-server.ts](dev-server.ts)
(Ersatz für `server/upload.php` und für einen Cloud-Ordner mit öffentlichem Link). Es gibt kein separates Backend zu starten.

1. **Starten:** `npm install` (einmalig), dann `npm run dev`. Die Ausgabe nennt `Local:` (`http://localhost:5173`)
   und `Network:` (für das Tablet im selben WLAN). Beenden mit `Strg+C`.
   Meldet Vite `Port 5173 is already in use`, läuft bereits ein Dev-Server – diesen weiterverwenden oder
   mit `npm run dev -- --port 5174` einen zweiten starten.
2. **Im Browser:** `http://localhost:5173` öffnen, mit `mischer` / `mischer` anmelden. Für den Upload unter
   *Einstellungen → Upload-Ziele* das Profil „Lokaler Test-Server“ wählen (URL `/api/upload`, Token `dev-token`);
   bei Termine ist im Dev-Server alles schon voreingestellt (Art OpenCloud, Link `http://localhost:5173/s/dev-token`, Passwort `dev-token`).
3. **Endpunkte per `curl` prüfen** (in einem zweiten Terminal; `B` ggf. an den Port anpassen):

   ```sh
   B=http://localhost:5173
   printf 'ID3\x03\x00\x00\x00\x00\x00\x00fake' > test.mp3      # Minimal-"MP3" mit ID3-Kopf

   # Upload (Header X-Upload-Token, Feld "file")
   curl -i -X POST $B/api/upload -F file=@test.mp3                                  # 401 (kein Token)
   curl -i -X POST $B/api/upload -H 'X-Upload-Token: dev-token' -F file=@test.mp3   # 200 {"ok":true,...}
   curl -i -X POST $B/api/upload -H 'X-Upload-Token: dev-token' -F file=@test.mp3   # 409 (gibt es schon)

   # Termine-Tabelle im Test-Cloud-Ordner (WebDAV wie bei OpenCloud: Basic public:dev-token)
   D=$B/dav/public-files/dev-token/termine.xlsx
   curl -u public:dev-token -o /dev/null -w '%{http_code}\n' $D                      # 404, solange noch nichts gespeichert ist
   curl -u public:dev-token -X PUT -H 'If-None-Match: *' --data-binary @tabelle.xlsx $D   # 201; nochmal: 412
   curl -u public:dev-token -o termine.xlsx $D                                         # Tabelle herunterladen

   Erwartete Statuscodes: `401` falsches/fehlendes Token bzw. Passwort, `400` ungültiger Name, `409` Datei existiert schon, `413` zu groß (80 MB), `415` keine MP3, `405` falsche Methode.
4. **Ergebnis ansehen:** Uploads liegen in `uploads-dev/`, die Termine-Tabelle in `uploads-dev/termine.xlsx` (lässt sich mit Excel/LibreOffice öffnen).
   Zum Zurücksetzen die Dateien dort löschen (der Ordner ist in `.gitignore`).
5. **Tests:** `npm test` prüft Namensschema, Termine-Datenmodell, xlsx-Tabelle samt Cloud-Zugriff (mit Nachbau eines Cloud-Ordners) und Audio-Erkennung (läuft ohne Server).
   Der Produktions-Build wird mit `npm run build && npm run preview` (Port 4173) auf dieselbe Weise getestet.

Das echte `upload.php` läuft nicht im Dev-Server. Wer es lokal ausprobieren will (PHP muss installiert sein), kann
`php -S localhost:8000 -t server` verwenden, im Skript Token und `TARGET_DIR` setzen und in der App
`http://localhost:8000/upload.php` eintragen (nicht getestet; `localhost:5173` steht bereits in `ALLOWED_ORIGINS`).

Eine echte OpenCloud für die Termine (und den Upload) startet `scripts/cloud-testserver.sh` (siehe unten); der Freigabe-Link darf
für beide Apps derselbe sein.

## Ablauf in der App

1. **Laden** – MP3 hineinziehen. Die Datei wird einmal komplett dekodiert (Web Worker, mpg123/WASM):
   Wellenform-Peaks, Merkmale für die Erkennung und ein Frame-Index für exaktes Springen.
2. **Schnitt** – Vorschlag für Start/Ende als orange Region; Übersicht mit Sprache/Musik/Stille,
   Alternativ-Vorschläge, Vorhören, Feinjustieren (Tastatur: Leertaste, S/E, ←/→, Umschalt, P).
3. **Lautheit** – Messung nach EBU R128 (BS.1770), Anhebung auf Ziel (Standard −19 LUFS mono),
   Look-ahead-Limiter, optional Hochpass 80 Hz und sanfte Kompression. Ein einziger Dekodier-Durchlauf:
   Die Eingangslautheit ist aus der Analyse schon bekannt; der Limiter läuft parallel mit drei Verstärkungen,
   die passende wird interpoliert.
4. **Export** – MP3 (LAME/WASM, CBR), ID3-Tags, Dateiname nach Schema `predigt_eag_{datum}`.
   Die angezeigte Lautheit wird am fertigen MP3 gemessen.
5. **Upload** – in einen Cloud-Ordner (OpenCloud/Nextcloud, öffentlicher Link) oder an `server/upload.php`,
   mit Fortschritt; alternativ Herunterladen. Vorhandene Dateien werden nie überschrieben.

## Cloud-Ordner einrichten (OpenCloud / Nextcloud)

1. In der Cloud einen Ordner (z. B. „Predigten“) per **öffentlichem Link** teilen, Berechtigung
   „Bearbeiten“/„Hochladen“ oder „Nur hochladen“ (Dateiablage), mit Passwort.
2. In der App: **Einstellungen → Upload-Ziele → + Ziel hinzufügen**, Art wählen, Freigabe-Link
   (`https://cloud…/s/AbC123`) und Link-Passwort eintragen. Per „Als JSON exportieren“ (mit Token)
   lässt sich das an die anderen Mischer weitergeben.
3. **Einmalig beim Cloud-Admin:** Die Cloud muss Uploads von der Adresse der App erlauben (CORS),
   sonst blockiert der Browser („Cloud nicht erreichbar … CORS“):
   - **OpenCloud:** Umgebungsvariable `OC_CORS_ALLOW_ORIGINS=https://NAME.github.io` (mehrere mit Komma).
   - **Nextcloud (Apache):** `server/cloud/nextcloud-apache-cors.conf` einbinden, Adresse eintragen,
     Apache neu laden. Nextcloud ≥ 29 nötig. Bei gehosteten Nextclouds ohne Zugriff auf die
     Server-Konfiguration geht es nicht – dann Herunterladen oder anderer Weg.

Verhalten: Vor dem Upload prüft die App, ob die Datei schon existiert (Meldung statt Überschreiben).
Bei Nextcloud-„Dateiablage“-Links ist diese Prüfung nicht möglich; Nextcloud legt dann „… (2).mp3“ an.
Falsche Passwörter zählen bei Nextcloud zum Brute-Force-Schutz (nach mehreren Fehlversuchen wird gebremst).

Lokal ausprobieren: `scripts/cloud-testserver.sh` startet eine OpenCloud in Docker
(https://localhost:9200, Zertifikatswarnung einmal im Browser bestätigen) und gibt Link und Passwort aus.

## Eigenes Upload-Skript (PHP)

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

Die Antworten müssen für alle sichtbar sein, also braucht es einen gemeinsamen Speicher. Dafür dient eine **Excel-Datei
(`termine.xlsx`) in einem Cloud-Ordner** (OpenCloud oder Nextcloud). Ein eigener Server oder PHP ist nicht nötig; die App
(GitHub Pages) liest und schreibt die Datei direkt per WebDAV über einen öffentlichen Freigabe-Link.

1. In der Cloud einen Ordner (z. B. „Termine“) per **öffentlichem Link** teilen, Berechtigung **„Bearbeiten“** (nicht nur
   „Hochladen“ – die App muss die Datei auch lesen können), mit Passwort. Der Ordner aus „Cloud-Ordner einrichten“ geht auch.
2. Damit der Browser auf die Cloud zugreifen darf, muss der Cloud-Admin die Adresse der App einmalig freigeben (CORS):
   - **OpenCloud:** `OC_CORS_ALLOW_ORIGINS=https://NAME.github.io` (wie beim Upload).
   - **Nextcloud (Apache):** `server/cloud/nextcloud-apache-cors.conf` einbinden (erlaubt jetzt auch Lesen und `If-Match`).
3. In der App unter **⚙ Einstellungen** Art, Freigabe-Link, Passwort und Dateiname eintragen (an alle Mischer weitergeben;
   wird nur im Browser gespeichert). Die Datei wird beim ersten Speichern angelegt.
4. Jede Person trägt oben ihr Kürzel ein; es bleibt im Browser gespeichert.

**Die Datei ist menschenlesbar** und darf auch direkt in der Cloud oder in Excel bearbeitet werden:

| Datum | Wochentag | Uhrzeit | Anlass | Eingeteilt | Hinweis | JD | MK |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 25.10.2026 | Sonntag | 10:00 | Abendmahl | JD, MK | … | Ja | Vielleicht |

Eine Zeile pro Termin; ab Spalte G eine Spalte pro Kürzel (Überschrift = Kürzel) mit `Ja`, `Vielleicht` oder `Nein` (leer =
keine Antwort; auch `j`, `n`, `?` werden verstanden). „Wochentag“ ist nur zur Ansicht und wird ignoriert. Das Datum darf ein
Datumsfeld oder Text wie `25.10.2026` / `2026-10-25` sein. Zeilen ohne gültiges Datum ignoriert die App (sie warnt, und beim nächsten
Speichern gehen sie verloren). Die Spalten A–F müssen an ihrer Stelle bleiben; Formatierung ist egal, sie wird beim Speichern neu gesetzt.

**Gleichzeitiges Speichern:** Eine Cloud hat keine Sperre wie ein eigener Server. Die App liest daher vor jeder Änderung die
aktuelle Datei, schreibt sie zurück (mit `If-Match`, wo die Cloud das unterstützt – OpenCloud ignoriert es, getestet; bei Nextcloud ungetestet) und liest
sie danach zur Kontrolle noch einmal; fehlt die eigene Änderung, weil jemand gleichzeitig geschrieben hat, wird sie erneut eingetragen.
Getestet mit einer echten OpenCloud (mehrere gleichzeitige Antworten bleiben erhalten; bei sehr vielen exakt gleichzeitigen Änderungen
meldet die App „bitte noch einmal versuchen“, statt still etwas zu verlieren). Eine kleine Lücke von wenigen 100 ms bleibt – für ein
kleines Team ausreichend. Jeder mit Link und Passwort kann alle Termine bearbeiten und unter jedem Kürzel antworten.
Wer die Datei gerade im Online-Editor der Cloud offen hat, kann sie kurz sperren (Meldung „gesperrt“, später erneut versuchen).

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
apps/termine/                Termine (src/model.ts: Datenmodell, src/xlsx.ts: Tabelle, src/api.ts: Cloud-Zugriff)
packages/audio-core/         Decoder, Frame-Index, Merkmale, Erkennung, Lautheit, DSP, Pipeline, Worker
packages/upload/             HTTP-Upload mit Fortschritt
packages/settings/           localStorage-Store mit JSON-Export/-Import
packages/auth/               Login-Sperre
packages/ui-kit/             DOM-Helfer, Styles
server/                      upload.php und Vorlagen für den Zielserver (nicht Teil des Builds)
scripts/                     bench.ts (Erkennungs-Benchmark), make-synthetic.py
dev-server.ts                Test-Endpunkte (Upload, Cloud-Ordner für Termine) für dev/preview
```

Neue App: Ordner unter `apps/`, Eintrag in `apps.json` und in `vite.config.ts` (`rollupOptions.input`).

## Bekannte Grenzen / noch offen

- Die Erkennungs-Schwellen sind Startwerte (Phase 5 des Plans); sie müssen mit echten Aufnahmen kalibriert werden.
- Transkript-Verfeinerung (Whisper), PWA/Offline und Stapelverarbeitung sind noch nicht umgesetzt (Phase 7).
- Der Export wird immer mit 44,1 kHz kodiert (48-kHz-Quellen resampelt LAME).
- Die Beispiel-Dateien (`predigt-beispiele.zip`) sind bereits geschnittene Predigten; zum Kalibrieren der
  Erkennung werden die vollständigen Gottesdienst-Mitschnitte gebraucht.
