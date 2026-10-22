# Audio-Werkzeuge – Predigt-Schnitt & Termine

Zwei Apps unter einer Startseite, betrieben auf dem eigenen NAS (ein Docker-Container: Web-App + kleiner Server):

- **Predigt-Schnitt** (`apps/predigt-schnitt/`) – Browser-App, die eine Gottesdienst-Aufnahme (MP3) lädt, die Predigt
  automatisch erkennt, die Lautheit normalisiert, als MP3 exportiert und auf das NAS hochlädt.
  Alles läuft im Browser; das Audio verlässt den Rechner erst beim Upload.
  Umsetzung von [Planung_Predigt-Schnitt-WebApp.md](Planung_Predigt-Schnitt-WebApp.md).
- **Termine** (`apps/termine/`) – Liste der kommenden Sonntage; jede Person sagt mit ihrem Kürzel (z. B. `JD`)
  Ja / Vielleicht / Nein. Alle sehen, wer was geantwortet hat und wer noch offen ist. Der Admin trägt pro Termin
  Anlass, Uhrzeit, Einteilung und Hinweise ein; sagt eine eingeteilte Person ab, wird das markiert.
  Alles steht in einer Excel-Datei auf dem NAS ([Termine](#termine)).

## Benutzer

Die Anmeldung läuft über den Server (Cookie, 30 Tage); Benutzer und Passwörter stehen in einer **Konfigurationsdatei**,
die nicht im Repository liegt ([Konfiguration](#konfiguration)).

| Benutzer | Darf |
| --- | --- |
| `mischer` | Termine ansehen und beantworten · Aufnahmen schneiden und aufs NAS hochladen. Keine Einstellungen. |
| `admin` | alles von `mischer` · Termine anlegen und bearbeiten · Excel-Tabelle herunter-/hochladen · Einstellungen (Lautheit, Export, Namensschema, Cover, Anzahl Sonntage, zusätzliche Upload-Ziele) |

Die Einstellungen des Admins gelten für alle (sie liegen auf dem Server, `settings.json`). Die Oberfläche blendet für
`mischer` alles Weitere aus; der Server prüft jede Anfrage selbst. Falsche Passwörter bremsen den Zugang
(8 Fehlversuche pro Adresse → 15 Minuten Pause).

## Auf dem NAS betreiben

Voraussetzung: Docker (Synology: Container Manager bzw. Portainer) und ein Reverse-Proxy mit HTTPS, z. B. `https://mischer.jujo.myds.me`.
Die App muss unter der **Wurzel einer Adresse** laufen (eigene Subdomain, kein Unterpfad).

1. **Ordner anlegen:** `/volume1/docker/mischer/config/` und `/volume1/docker/mischer/data/`.
2. **Konfiguration:** `config.example.json` als `/volume1/docker/mischer/config/config.json` ablegen und die beiden Passwörter eintragen
   (siehe [Konfiguration](#konfiguration)). Solange dort `CHANGE-ME` steht, startet der Container nicht.
3. **Container bauen und starten** – mit [docker-compose.yml](docker-compose.yml) aus diesem Repository:
   - *Portainer:* Stacks → Add stack → **Repository** → `https://github.com/Joe91/mischerapps`, Compose-Pfad `docker-compose.yml`,
     Deploy. Portainer baut das Image auf dem NAS.
   - *Kommandozeile:* Repository klonen, `docker compose up -d --build`.

   Der Container hört auf Port `9120` (in der Compose-Datei änderbar) und läuft als Benutzer `1026:100` wie die anderen Stacks –
   der Ordner `data` muss für diesen Benutzer beschreibbar sein.
4. **Reverse-Proxy** (DSM → Anmeldeportal → Erweitert → Reverse-Proxy): Quelle `https://mischer.jujo.myds.me:443`,
   Ziel `http://localhost:9120`. Der Server wertet `X-Forwarded-For` / `X-Real-IP` (Sperre nach Fehlversuchen pro Adresse) und
   `X-Forwarded-Proto` (`Secure`-Cookie) aus. Falls DSM diese Kopfzeilen nicht mitschickt (sie lassen sich unter
   *Benutzerdefinierte Kopfzeile* ergänzen), zählen alle Fehlversuche zusammen, und das Cookie wird nur mit `"secureCookies": true`
   in der `config.json` als „Secure“ gesetzt. Große Uploads: bei einem weiteren nginx davor `client_max_body_size 200m;`.
5. **Aktualisieren:** neuen Stand holen und neu bauen (Portainer: Stack → *Pull and redeploy* mit „Re-build image“;
   Kommandozeile: `git pull && docker compose up -d --build`).

Gespeichert wird alles im Ordner `data` (sichern wie jeden anderen Ordner):

```
data/termine.xlsx          Termine und Antworten (Excel, auch von Hand bearbeitbar)
data/termine.backup.xlsx   Stand vor dem letzten Hochladen einer Tabelle
data/settings.json         gemeinsame Einstellungen (vom Admin)
data/predigten/            hochgeladene MP3-Dateien
data/.session-secret       Schlüssel für die Anmelde-Cookies (wird automatisch angelegt)
```

### Gut zu wissen

- **Port nicht freigeben:** `9120` gehört nur hinter den Reverse-Proxy (nicht am Router weiterleiten). Sonst könnten Absender die
  Kopfzeile `X-Forwarded-For` fälschen und die Sperre nach Fehlversuchen umgehen.
- **Erste Einrichtung:** Als `admin` in Predigt-Schnitt ⚙ Einstellungen einmal Gemeinde, Prediger, Namensschema, Lautheit, Format und Cover
  prüfen und *Speichern* – erst dann gelten sie für `mischer` (bis dahin nutzt dessen Browser die Standardwerte).
- **Sichern:** den Ordner `data` mitsichern (z. B. Hyper Backup). Wiederherstellen = Ordner zurückkopieren.
- **Abmelden** löscht nur das Cookie dieses Browsers. Alle Anmeldungen eines Benutzers werden ungültig, wenn sein Passwort in der
  `config.json` geändert wird (Container neu starten).
- **Safari (iPad/iPhone)** löscht lokal gespeicherte Daten von Webseiten nach etwa 7 Tagen ohne Nutzung: Das Kürzel muss dann neu
  eingetragen werden; die Anmeldung selbst bleibt (sie liegt im Server-Cookie).
- **Upload-Größe:** Der Server hält eine Datei beim Hochladen im Speicher (etwa das Vierfache der Dateigröße, 30 MB ≈ 120 MB RAM).
  Grenze: `maxUploadMb` (Standard 150).
- **`termine.xlsx` am NAS direkt bearbeiten** geht, aber wer genau dann antwortet, wenn die Datei gespeichert wird, kann überschrieben
  werden. Sicherer: in der App herunterladen, bearbeiten, wieder hochladen.
- Baut Portainer das Image nicht (Fehler „image not found“): auf dem NAS per SSH im geklonten Ordner `docker compose up -d --build`.

### Konfiguration

`config.example.json` ist die Vorlage; die echte `config.json` gehört **nicht** ins Repository (steht in `.gitignore`).

```json
{
  "users": {
    "admin":   { "password": "…" },
    "mischer": { "password": "…" }
  }
}
```

- Passwörter mindestens 8 Zeichen, für beide verschieden. Platzhalter (`CHANGE-ME…`) werden abgelehnt.
- Statt Klartext geht auch ein Hash: `npm run hash-password -- 'mein passwort'` (oder im Container
  `node dist-server/hash-password.mjs 'mein passwort'`) und die Ausgabe (`scrypt$…`) als Passwort eintragen.
- Nach einer Änderung den Container neu starten; alle Anmeldungen des geänderten Benutzers werden dabei ungültig.
- Optional: `"sessionDays": 30`, `"maxUploadMb": 150`, `"secureCookies": true`, `"sessionSecret": "…"` (mind. 16 Zeichen).
- Der Pfad der Datei kann über die Umgebungsvariable `CONFIG_FILE` geändert werden (Standard `/config/config.json`);
  weitere Variablen: `DATA_DIR` (`/data`), `STATIC_DIR` (`/app/dist`), `PORT` (`8080`).

## Termine

Eine Zeile pro Termin in `data/termine.xlsx`, ab Spalte G eine Spalte pro Kürzel (Überschrift = Kürzel) mit `Ja`, `Vielleicht`
oder `Nein`:

| Datum | Wochentag | Uhrzeit | Anlass | Eingeteilt | Hinweis | JD | MK |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 25.10.2026 | Sonntag | 10:00 | Abendmahl | JD, MK | … | Ja | Vielleicht |

- Der Admin kann in der App Termine bearbeiten oder löschen und mit „+ Weiterer Termin“ einen Termin an einem anderen Tag anlegen
  (z. B. Karfreitag). **Einstellungen → Tabelle** lädt die Excel-Datei herunter bzw. ersetzt mit einer hochgeladenen Datei
  *alle* Termine (der alte Stand bleibt als `termine.backup.xlsx` liegen).
- Die Datei darf auch direkt auf dem NAS bearbeitet werden; der Server liest sie bei jeder Anfrage neu. Verstanden werden
  `j`/`n`/`?` als Antworten, Datumsfelder oder Text wie `25.10.2026` / `2026-10-25`, Uhrzeiten als Text oder Zeitfeld.
  „Wochentag“ wird ignoriert; die Spalten A–F müssen an ihrer Stelle bleiben. Zeilen ohne gültiges Datum werden ignoriert
  (der Admin sieht eine Warnung; beim nächsten Speichern gehen sie verloren).
- Eine kaputte `termine.xlsx` wird nie überschrieben: Die App meldet dann einen Serverfehler, bis die Datei repariert
  oder gelöscht ist.
- Gleichzeitige Antworten gehen nicht verloren: Der Server führt Änderungen nacheinander aus und schreibt die Datei atomar.
- Angezeigt werden die nächsten 12 Sonntage (Admin: einstellbar), ältere per „Ältere anzeigen“. Die Liste aktualisiert sich jede Minute.
- Wer antwortet, trägt oben sein Kürzel ein (bleibt im Browser). Wer mit welchem Kürzel antwortet, wird nicht geprüft –
  gedacht für ein kleines, vertrautes Team.

## Lokal entwickeln

```sh
npm install
npm run dev          # http://localhost:5173 – auch im LAN erreichbar (Tablet-Test)
npm test             # Unit- und Server-Tests (Vitest)
npm run build        # Web-App nach dist/
npm run build:server # Server nach dist-server/ (für das Docker-Image)
npm run preview      # dist/ lokal ausliefern (http://localhost:4173)
```

`npm run dev` und `npm run preview` enthalten dieselbe API wie der echte Server, mit festen Test-Anmeldungen
`admin` / `admin` und `mischer` / `mischer`. Daten (Termine, Uploads, Einstellungen) liegen in `uploads-dev/`
(zum Zurücksetzen löschen; der Ordner ist in `.gitignore`).

Den echten Server samt Image lokal ausprobieren:

```sh
docker build -t mischer-app .
mkdir -p /tmp/mischer/config /tmp/mischer/data && chmod 777 /tmp/mischer/data
cp config.example.json /tmp/mischer/config/config.json     # Passwörter eintragen!
docker run --rm -p 9120:8080 -v /tmp/mischer/config:/config:ro -v /tmp/mischer/data:/data mischer-app
```

Die API (alle unter `/api`, Anmeldung per Cookie): `POST login` / `logout`, `GET me`, `GET`/`POST termine`,
`GET termine/export` und `POST termine/import` (Admin), `GET`/`PUT settings/<app>` (PUT: Admin), `POST upload` (Feld `file`),
`GET uploads` (Admin), `GET health`. Fehlercodes des Uploads: `401` nicht angemeldet, `400` ungültiger Name, `409` Datei existiert schon,
`413` zu groß, `415` keine MP3.

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
5. **Upload** – auf das NAS (Ordner `predigten` im Datenverzeichnis), mit Fortschritt; alternativ Herunterladen.
   Vorhandene Dateien werden nie überschrieben. Der Admin kann zusätzlich einen Cloud-Ordner als Ziel eintragen.

## Zusätzliches Upload-Ziel: Cloud-Ordner (optional, nur Admin)

1. In der Cloud einen Ordner (z. B. „Predigten“) per **öffentlichem Link** teilen, Berechtigung
   „Bearbeiten“/„Hochladen“ oder „Nur hochladen“ (Dateiablage), mit Passwort.
2. In der App (als Admin): **Einstellungen → Upload-Ziele → + Ziel hinzufügen**, Art wählen, Freigabe-Link
   (`https://cloud…/s/AbC123`) und Link-Passwort eintragen. Zusätzliche Ziele gelten nur in diesem Browser;
   der „mischer“-Benutzer lädt immer auf das NAS.
3. **Einmalig beim Cloud-Admin:** Die Cloud muss Uploads von der Adresse der App erlauben (CORS),
   sonst blockiert der Browser („Cloud nicht erreichbar … CORS“):
   - **OpenCloud:** Umgebungsvariable `OC_CORS_ALLOW_ORIGINS=https://mischer.jujo.myds.me` (mehrere mit Komma).
   - **Nextcloud (Apache):** `server/cloud/nextcloud-apache-cors.conf` einbinden, Adresse eintragen,
     Apache neu laden. Nextcloud ≥ 29 nötig. Bei gehosteten Nextclouds ohne Zugriff auf die
     Server-Konfiguration geht es nicht – dann Herunterladen oder anderer Weg.

Verhalten: Vor dem Upload prüft die App, ob die Datei schon existiert (Meldung statt Überschreiben).
Bei Nextcloud-„Dateiablage“-Links ist diese Prüfung nicht möglich; Nextcloud legt dann „… (2).mp3“ an.
Falsche Passwörter zählen bei Nextcloud zum Brute-Force-Schutz (nach mehreren Fehlversuchen wird gebremst).

Lokal ausprobieren: `scripts/cloud-testserver.sh` startet eine OpenCloud in Docker
(https://localhost:9200, Zertifikatswarnung einmal im Browser bestätigen) und gibt Link und Passwort aus.

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
apps/termine/                Termine (src/model.ts: Datenmodell, src/xlsx.ts: Excel-Tabelle, src/api.ts: Zugriff auf den Server)
packages/audio-core/         Decoder, Frame-Index, Merkmale, Erkennung, Lautheit, DSP, Pipeline, Worker
packages/upload/             Upload auf den Server und in Cloud-Ordner
packages/settings/           localStorage-Store mit JSON-Export/-Import, gemeinsame Einstellungen vom Server
packages/auth/               Anmeldung am Server (Rollen admin / mischer)
packages/ui-kit/             DOM-Helfer, Styles
server/                      Server: api.ts (Anmeldung, Termine, Einstellungen, Upload), static.ts, main.ts, config.ts, auth.ts
server/cloud/                CORS-Vorlage für Nextcloud (nur für das optionale Cloud-Upload-Ziel)
Dockerfile, docker-compose.yml, config.example.json   Betrieb auf dem NAS
scripts/                     bench.ts (Erkennungs-Benchmark), make-synthetic.py, cloud-testserver.sh
dev-server.ts                bindet die API in `npm run dev` / `preview` ein
```

Neue App: Ordner unter `apps/`, Eintrag in `apps.json` und in `vite.config.ts` (`rollupOptions.input`).

## Bekannte Grenzen / noch offen

- Die Erkennungs-Schwellen sind Startwerte (Phase 5 des Plans); sie müssen mit echten Aufnahmen kalibriert werden.
- Transkript-Verfeinerung (Whisper), PWA/Offline und Stapelverarbeitung sind noch nicht umgesetzt (Phase 7).
- Der Export wird immer mit 44,1 kHz kodiert (48-kHz-Quellen resampelt LAME).
- Die Beispiel-Dateien (`predigt-beispiele.zip`) sind bereits geschnittene Predigten; zum Kalibrieren der
  Erkennung werden die vollständigen Gottesdienst-Mitschnitte gebraucht.
