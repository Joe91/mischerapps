# Mischer-Apps – Predigt-Schnitt & Termine

Apps unter einer Startseite, betrieben auf dem eigenen NAS (ein Docker-Container: Web-App + kleiner Server):

- **Predigt-Schnitt** (`apps/predigt-schnitt/`) – Browser-App, die eine Gottesdienst-Aufnahme (MP3) lädt, die Predigt
  automatisch erkennt, die Lautheit normalisiert, als MP3 exportiert und auf das NAS hochlädt.
  Alles läuft im Browser; das Audio verlässt den Rechner erst beim Upload.
  Umsetzung von [Planung_Predigt-Schnitt-WebApp.md](Planung_Predigt-Schnitt-WebApp.md).
- **Termine** (`apps/termine/`) – Liste der kommenden Sonntage; jede Person sagt mit ihrem Kürzel (z. B. `JD`)
  Ja / Vielleicht / Nein. Alle sehen, wer was geantwortet hat und wer noch offen ist. Der Admin trägt pro Termin
  Anlass, Uhrzeit, Einteilung und Hinweise ein; sagt eine eingeteilte Person ab, wird das markiert.
  Alles steht in einer Excel-Datei auf dem NAS ([Termine](#termine)).
- **Predigt nachbearbeiten** (`apps/predigt-nachbearbeiten/`, nur Admin) – eine schon veröffentlichte Predigt vom NAS
  oder vom Rechner (auch mehrere nacheinander) noch einmal mit den aktuellen Einstellungen bearbeiten (z. B. Hall & Rauschen
  reduzieren) und auf dem NAS ersetzen
  ([Nachbearbeiten](#predigt-nachbearbeiten-nur-admin)).

## Benutzer

Die Anmeldung läuft über den Server (Cookie, 30 Tage); Benutzer und Passwörter stehen in einer **Konfigurationsdatei**,
die nicht im Repository liegt ([Konfiguration](#konfiguration)).

| Benutzer | Darf |
| --- | --- |
| `mischer` | Termine ansehen und beantworten · Aufnahmen schneiden und aufs NAS hochladen. Keine Einstellungen. |
| `admin` | alles von `mischer` · Termine anlegen und bearbeiten · veröffentlichte Predigten nachbearbeiten und ersetzen · Excel-Tabelle herunter-/hochladen · Einstellungen (Lautheit, Export, Namensschema, Cover, Anzahl Sonntage, zusätzliche Upload-Ziele) |

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

   Der Container hört auf Port `9120`, und zwar nur auf dem NAS selbst (`127.0.0.1`, in der Compose-Datei änderbar), und läuft als Benutzer `1026:100` wie die anderen Stacks –
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
data/einsatzplan.xlsx      Einsatzplan (Mischer, Beamer, Musikteam), so wie der Admin ihn hochgeladen hat
data/settings.json         gemeinsame Einstellungen (vom Admin)
data/predigten/            hochgeladene MP3-Dateien
data/predigten/original/   die zuerst veröffentlichte Fassung nachbearbeiteter Predigten
data/.session-secret       Schlüssel für die Anmelde-Cookies (wird automatisch angelegt)
```

Auf dem NAS ist das `/volume1/docker/mischer/data/` (File Station: `docker` → `mischer` → `data`). Die Dateien entstehen erst bei Bedarf:
`termine.xlsx` bei der ersten Änderung an den Terminen, `settings.json` beim ersten Speichern der Einstellungen, `predigten/` beim ersten
Upload. Dateien mit Punkt am Anfang (`.session-secret`) zeigt File Station nur an, wenn „Versteckte Dateien anzeigen“ aktiv ist.

### Gut zu wissen

- **Port nur für den Reverse-Proxy:** Die Compose-Datei bindet `9120` an `127.0.0.1`, also ist er nur vom NAS selbst erreichbar,
  nicht aus dem Netz und nicht über den Router. Wer den Proxy umgehen kann, könnte die Kopfzeile `X-Forwarded-For` fälschen und
  die Sperre nach Fehlversuchen aushebeln. Deshalb diese Bindung beibehalten und den Port nicht am Router weiterleiten.
- **Handarbeit in `termine.xlsx`** bleibt erhalten: eigene Spalten (z. B. „Bemerkung“), Kürzel-Spalten ohne Antworten,
  sonstiger Text in einer Kürzel-Spalte und Zeilen ohne Datum werden bei jeder Änderung aus der App unverändert zurückgeschrieben.
  Eine Antwort aus der App ersetzt den Text in ihrer Zelle.
- **`settings.json` von Hand ändern:** Ist die Datei danach kein gültiges JSON mehr, nutzt der Server sie nicht und überschreibt
  sie auch nicht. Die App meldet das beim Speichern; bis zur Reparatur gelten die Werte im jeweiligen Browser.
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
- Meldet Portainer beim Aktualisieren „pull access denied for mischer-app“: Das Image gibt es nur lokal, nicht bei Docker Hub. Die
  Compose-Datei hat deshalb keinen `image:`-Namen (dann überspringt der Pull-Schritt es); bei einem älteren Stand `image:` entfernen
  oder beim Neu-Deployen „Re-pull image“ aus- und „Re-build image“ einschalten.

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

- **Die Zeilen der Tabelle sind die Termine der App.** Es gibt keine automatisch erzeugten Sonntage: Was nicht in der Tabelle steht,
  erscheint nicht – und beantwortet werden kann nur, was dort steht. Eine Zeile mit nur einem Datum genügt.
- **Termine auswählen:** *Einstellungen → Termine (Excel) → ⬇ Vorlage mit allen Sonntagen* lädt eine Tabelle mit den bisherigen Terminen
  (samt Antworten) und den nächsten 52 Sonntagen. Zeilen von Sonntagen, an denen nichts anliegt, in Excel löschen, speichern und mit
  *⬆ Hochladen* wieder einspielen. Zusätzlich kann der Admin mit „+ Termin hinzufügen“ einzelne Tage anlegen (Sonntag oder z. B. Karfreitag)
  und Termine in der App bearbeiten oder löschen.
- *Aktuelle Tabelle* lädt die Excel-Datei so herunter, wie sie auf dem Server liegt. Das Hochladen ersetzt *alle* Termine
  (der alte Stand bleibt als `termine.backup.xlsx` liegen).
- Die Datei darf auch direkt auf dem NAS bearbeitet werden; der Server liest sie bei jeder Anfrage neu. Verstanden werden
  `j`/`n`/`?` als Antworten, Datumsfelder oder Text wie `25.10.2026` / `2026-10-25`, Uhrzeiten als Text oder Zeitfeld.
  „Wochentag“ wird ignoriert; die Spalten A–F müssen an ihrer Stelle bleiben. Zeilen ohne gültiges Datum werden ignoriert
  (der Admin sieht eine Warnung; beim nächsten Speichern gehen sie verloren).
- Eine kaputte `termine.xlsx` wird nie überschrieben: Die App meldet dann einen Serverfehler, bis die Datei repariert
  oder gelöscht ist.
- Gleichzeitige Antworten gehen nicht verloren: Der Server führt Änderungen nacheinander aus und schreibt die Datei atomar.
- Angezeigt werden alle kommenden Termine der Tabelle, vergangene per „Ältere anzeigen“. Die Liste aktualisiert sich jede Minute.
- Wer antwortet, trägt oben sein Kürzel ein (bleibt im Browser). Wer mit welchem Kürzel antwortet, wird nicht geprüft –
  gedacht für ein kleines, vertrautes Team.

## Einsatzplan auf der Startseite

Der Admin lädt auf der Startseite mit *⬆ Plan importieren* die Excel-Tabelle der Gemeinde hoch (z. B. `Musik_Mischer_Beamer.xlsx`).
Gelesen wird nur das **erste Blatt**: Die Spalten werden an ihrer Überschrift erkannt (`Datum`, `Musikteam`, `Teamleitung`,
`Mischer`, `Beamer`, optional `Besonderheiten` und `Bemerkungen`), ihre Reihenfolge und weitere Spalten sind egal.

- Termine mit „kein eAg“ (in Musikteam, Teamleitung, Mischer, Beamer oder Besonderheiten) werden ausgeblendet.
- Zeilen ohne Datum unter den Terminen dürfen eine Legende enthalten: Kürzel und daneben der volle Name (`KL | Udo Klaus`).
  Angemeldete sehen dann Namen statt Kürzel.
- **Ohne Anmeldung** zeigt die Startseite die nächsten drei Termine – nur mit Kürzeln, ohne Namen und Bemerkungen.
  **Angemeldet** stehen die nächsten zwei Termine groß oben, alle weiteren (auch vergangene) hinter *Alle Termine anzeigen*.
- Ein neuer Import ersetzt den alten Plan. Eine Datei ohne die Spalten „Datum“ und „Mischer“ wird abgelehnt, der alte Plan bleibt.
  `data/einsatzplan.xlsx` kann auch direkt auf dem NAS ersetzt werden.
- In der App **Termine** steht bei einem Termin ohne eigenes „Eingeteilt“ der Mischer aus dem Einsatzplan (markiert mit
  *laut Einsatzplan*; ★ und Absage-Warnung gelten dafür genauso). Er wird nicht in `termine.xlsx` gespeichert, folgt also einem neu
  importierten Plan. Ein eigener Eintrag unter *Bearbeiten* hat Vorrang; das Feld leeren schaltet zurück auf den Plan.

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
`GET termine/export` und `POST termine/import` (Admin), `GET plan` (auch ohne Anmeldung, dann gekürzt) und `POST plan/import` (Admin, die xlsx als Body), `GET`/`PUT settings/<app>` (PUT: Admin), `POST upload?name=<datei>.mp3` (die MP3 als Body, `Content-Type: audio/mpeg`; wird direkt auf die Platte geschrieben),
`GET uploads` (Admin; je Datei `original: true`, wenn sie schon ersetzt wurde), `GET uploads/<datei>.mp3` (Admin, mit `?original=1` die zuerst
veröffentlichte Fassung), `PUT uploads/<datei>.mp3` (Admin: ersetzt eine vorhandene Datei, die MP3 als Body), `GET health`. Fehlercodes des Uploads: `401` nicht angemeldet, `400` ungültiger Name, `409` Datei existiert schon,
`413` zu groß, `415` keine MP3.

## Ablauf in der App

1. **Laden** – MP3 hineinziehen. Die Datei wird einmal komplett dekodiert (Web Worker, mpg123/WASM):
   Wellenform-Peaks, Merkmale für die Erkennung und ein Frame-Index für exaktes Springen.
2. **Schnitt** – Vorschlag für Start/Ende als orange Region; Übersicht mit Sprache/Musik/Stille,
   Alternativ-Vorschläge, Vorhören, Feinjustieren (Tastatur: Leertaste, S/E, ←/→, Umschalt, P).
3. **Export** – Titel, Prediger, Datum, Bibelstelle und Dateiname eintragen (Schema `predigt-eag-{jjmmdd}`,
   z. B. `predigt-eag-260712.mp3`). Lautheit und Klang werden automatisch nach den Voreinstellungen des Admins
   angepasst (Standard: −19 LUFS, höchstens +55 dB Anhebung, Hochpass 80 Hz, sanfte Kompression 2:1, Hall &
   Rauschen reduzieren, „Sprache hoch“ = Mono 96 kbps, 0,5 s Ausblenden – die Predigt endet meist mit „Amen“);
   Messung und MP3-Kodierung laufen schon im Hintergrund, während die Angaben ausgefüllt werden – „MP3 exportieren“
   schreibt dann nur noch die Tags (Titel, Prediger …) hinein und ist sofort fertig. **⚙ Erweitert** zeigt
   Messwerte und erlaubt, Zielwert, Format, Ein-/Ausblenden, Hochpass, Kompression und Hall-Reduzierung für diese eine Aufnahme
   zu ändern (die Voreinstellungen bleiben unverändert; Schließen stellt sie wieder her).
   Technik: Messung nach EBU R128 (BS.1770), Look-ahead-Limiter; ein einziger Dekodier-Durchlauf
   (die Eingangslautheit ist aus der Analyse bekannt, der Limiter läuft parallel mit drei Verstärkungen,
   die passende wird interpoliert). MP3 per LAME/WASM (CBR) mit ID3-Tags; die angezeigte Lautheit wird am
   fertigen MP3 gemessen.
   **Hall & Rauschen reduzieren** (Standard an): KI-Filter [DeepFilterNet3](https://github.com/Rikorose/DeepFilterNet)
   (MIT/Apache-2.0) als WebAssembly im Browser, nichts zu installieren. Senkt Nachhall und Hintergrundrauschen
   um höchstens 18 dB, so bleibt es natürlich (Stärke in den Einstellungen änderbar). Sehr leise Aufnahmen
   (Mischpult, −50 LUFS) werden dafür vorübergehend auf −23 LUFS angehoben – sonst hält das Modell die Stimme
   teils für Rauschen. Die Aufnahme wird in Abschnitte geteilt, die parallel in
   mehreren Workern laufen (je 10 s Vorlauf, 1 s Überblendung – vom Durchgang am Stück nicht zu unterscheiden):
   6-Kern-PC ≈ 35× Echtzeit (30 min Predigt ≈ 1 min), ein Kern ≈ 7×. Braucht einmalig ~11 MB Download sowie
   ~250 MB Arbeitsspeicher pro 30 min (Mono; Stereo etwa doppelt) und ~35 MB je Worker.
   Das Ergebnis wird für Messung und Kodierung wiederverwendet; ändern sich nur Lautheit oder Kompression, wird
   nicht neu gefiltert. Ist die Option an, startet der Filter schon im Schnitt-Schritt im Hintergrund (Vorschlag
   ± 30 s); Marker innerhalb dieses Bereichs zu verschieben braucht keinen neuen Durchgang.
4. **Upload** – auf das NAS (Ordner `predigten` im Datenverzeichnis), mit Fortschritt; alternativ Herunterladen.
   Vorhandene Dateien werden nie überschrieben. Der Admin kann zusätzlich einen Cloud-Ordner als Ziel eintragen.

## Predigt nachbearbeiten (nur Admin)

Für Predigten, die schon veröffentlicht sind, z. B. ältere Aufnahmen von vor der Hall- und Rauschreduzierung.
Die Kachel sieht nur der Admin; der Server lässt nur ihn zu.

1. **Predigten wählen** – zwei Quellen:
   - *Auf dem NAS:* Liste aller Dateien in `data/predigten/` (Suche nach Namensteil, z. B. `2606`), *Bearbeiten* lädt eine davon.
   - *Vom Rechner:* MP3-Dateien hineinziehen oder auswählen, auch mehrere auf einmal. Jede einzeln *Bearbeiten* oder
     **Alle nacheinander bearbeiten und hochladen**: Die Dateien laufen dann ohne weiteres Zutun mit den Einstellungen aus
     Schritt 2 durch und landen auf dem NAS (Status je Datei in der Liste, *Nach dieser Datei anhalten* möglich).
     Der Name auf dem NAS ist der Dateiname, bereinigt (`predigt-eag-261018(1).mp3` → `predigt-eag-261018-1.mp3`).
2. **Bearbeitung** – Lautheit, Format, Ein-/Ausblenden, Hochpass, Kompression, Hall & Rauschen für alle Dateien auf der Seite.
   Voreingestellt sind die Standardwerte von Predigt-Schnitt (auch 0,5 s Ein- und Ausblenden); Änderungen gelten nur hier,
   die Standardwerte bleiben unverändert.
3. **Datei** – die ganze Datei (kein Schnitt). Titel, Prediger/in, Album, Jahr, Kommentar und Cover werden aus der Datei
   übernommen und können geändert werden; hat der Admin ein Cover eingestellt, kann es das bisherige ersetzen. Hat eine Datei
   vom Rechner keine Tags, kommen sie von der gleichnamigen Datei auf dem NAS. Die Berechnung startet sofort im Hintergrund
   (15 min Predigt ≈ 45 s, 26 min ≈ 75 s auf einem 12-Kern-PC, mit Entrauschen). *MP3 erstellen*, vorher/nachher anhören, dann
   hochladen oder herunterladen.

**Ersetzen:** Liegt auf dem NAS schon eine Datei mit dem Namen, wird sie ersetzt (die App fragt vorher, beim Stapel einmal für alle);
sonst kommt eine neue dazu. Beim ersten Ersetzen verschiebt der Server die bisherige Datei nach `data/predigten/original/`;
spätere Durchgänge überschreiben nur die aktuelle Fassung. Die Liste markiert solche Dateien mit „nachbearbeitet“, und ein
erneutes Bearbeiten vom NAS startet von der ersten Fassung (nicht doppelt gefiltert); die aktuelle lässt sich per Knopf stattdessen laden.
Zurück zur ersten Fassung: die Datei aus `original/` in File Station über die aktuelle kopieren.

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
npm run bench -- datei.mp3 --render --denoise  # Export mit Hall-/Rauschreduzierung (Zeitmessung)
```

`python3 scripts/make-synthetic.py` erzeugt eine synthetische Testaufnahme (espeak-ng + Orgel-Synthese),
falls gerade keine echte zur Hand ist.

## Aufbau

```
index.html, src/home.ts      Startseite: Einsatzplan und Kacheln aus apps.json
packages/plan/               Einsatzplan aus der Excel-Tabelle der Gemeinde lesen
apps/predigt-schnitt/        Predigt-Schnitt (Schritte unter src/steps/)
apps/predigt-nachbearbeiten/ Predigt nachbearbeiten (nur Admin; nutzt die Bausteine von Predigt-Schnitt)
apps/termine/                Termine (src/model.ts: Datenmodell, src/xlsx.ts: Excel-Tabelle, src/api.ts: Zugriff auf den Server)
packages/audio-core/         Decoder, Frame-Index, Merkmale, Erkennung, Lautheit, DSP, Pipeline, Worker
packages/denoise/            Hall-/Rauschreduzierung: df3.wasm (DeepFilterNet3 mit Modell) und Wrapper;
                             wasm/ ist der Rust-Quelltext, neu bauen mit wasm/build.sh (nur nach Änderungen nötig)
packages/upload/             Upload auf den Server und in Cloud-Ordner
packages/settings/           localStorage-Store mit JSON-Export/-Import, gemeinsame Einstellungen vom Server
packages/auth/               Anmeldung am Server (Rollen admin / mischer)
packages/ui-kit/             DOM-Helfer, Styles
server/                      Server: api.ts (Anmeldung, Termine, Einsatzplan, Einstellungen, Upload), static.ts, main.ts, config.ts, auth.ts
server/cloud/                CORS-Vorlage für Nextcloud (nur für das optionale Cloud-Upload-Ziel)
Dockerfile, docker-compose.yml, config.example.json   Betrieb auf dem NAS
scripts/                     bench.ts (Erkennungs-Benchmark), make-synthetic.py, cloud-testserver.sh
dev-server.ts                bindet die API in `npm run dev` / `preview` ein
```

Neue App: Ordner unter `apps/`, Eintrag in `apps.json` (mit `"adminOnly": true` nur für den Admin sichtbar) und in `vite.config.ts` (`rollupOptions.input`).

## Bekannte Grenzen / noch offen

- Die Erkennungs-Schwellen sind Startwerte (Phase 5 des Plans); sie müssen mit echten Aufnahmen kalibriert werden.
- Transkript-Verfeinerung (Whisper), PWA/Offline und Stapelverarbeitung sind noch nicht umgesetzt (Phase 7).
- Der Export wird immer mit 44,1 kHz kodiert (48-kHz-Quellen resampelt LAME).
- Die Beispiel-Dateien (`predigt-beispiele.zip`) sind bereits geschnittene Predigten; zum Kalibrieren der
  Erkennung werden die vollständigen Gottesdienst-Mitschnitte gebraucht.
