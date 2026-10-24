# Mischer-Apps – Predigt-Schnitt & Termine

Apps unter einer Startseite, betrieben auf dem eigenen NAS (ein Docker-Container: Web-App + kleiner Server):

- **Predigt-Schnitt** (`apps/predigt-schnitt/`) – Browser-App, die eine Gottesdienst-Aufnahme (MP3) lädt, die Predigt
  automatisch erkennt, die Lautheit normalisiert, als MP3 exportiert und veröffentlicht: Der Server legt sie im gemeinsamen
  Ordner in OpenCloud ab ([OpenCloud](#opencloud-der-ordner-für-die-predigten)). Alles läuft im Browser; das Audio verlässt
  den Rechner erst beim Upload.
  Umsetzung von [Planung_Predigt-Schnitt-WebApp.md](Planung_Predigt-Schnitt-WebApp.md).
- **Termine** (`apps/termine/`) – Liste der kommenden Sonntage; jede Person sagt mit ihrem Kürzel (z. B. `JD`)
  Ja / Vielleicht / Nein. Alle sehen, wer was geantwortet hat und wer noch offen ist. Der Admin trägt pro Termin
  Anlass, Uhrzeit, Einteilung und Hinweise ein; sagt eine eingeteilte Person ab, wird das markiert.
  Alles steht in einer Excel-Datei auf dem NAS ([Termine](#termine)).
- **Predigt nachbearbeiten** (`apps/predigt-nachbearbeiten/`, nur Admin) – eine schon veröffentlichte Predigt aus OpenCloud
  oder vom Rechner (auch mehrere nacheinander) noch einmal mit den aktuellen Einstellungen bearbeiten (z. B. Hall & Rauschen
  reduzieren) und in OpenCloud ersetzen ([Nachbearbeiten](#predigt-nachbearbeiten-nur-admin)).

## Benutzer

Die Anmeldung läuft über den Server (Cookie, 30 Tage); Benutzer und Passwörter stehen in einer **Konfigurationsdatei**,
die nicht im Repository liegt ([Konfiguration](#konfiguration)).

| Benutzer | Darf |
| --- | --- |
| `mischer` | Termine ansehen und beantworten · Aufnahmen schneiden und veröffentlichen. Keine Einstellungen. |
| `admin` | alles von `mischer` · im Einsatzplan den Mischer eintragen · veröffentlichte Predigten nachbearbeiten und ersetzen · Einstellungen (Lautheit, Export, Namensschema, Cover, Anzahl Sonntage) |

Die Einstellungen des Admins gelten für alle (sie liegen auf dem Server, `settings.json`). Die Oberfläche blendet für
`mischer` alles Weitere aus; der Server prüft jede Anfrage selbst. Falsche Passwörter bremsen den Zugang
(8 Fehlversuche pro Adresse → 15 Minuten Pause).

## Auf dem NAS betreiben

Voraussetzung: Docker (Synology: Container Manager bzw. Portainer) und ein Reverse-Proxy mit HTTPS, z. B. `https://mischer.jujo.myds.me`.
Die App muss unter der **Wurzel einer Adresse** laufen (eigene Subdomain, kein Unterpfad).

1. **Ordner anlegen:** `/volume1/docker/mischer/config/` und `/volume1/docker/mischer/data/`.
2. **Konfiguration:** `config.example.json` als `/volume1/docker/mischer/config/config.json` ablegen, die beiden Passwörter und den
   Zugang zu OpenCloud eintragen (siehe [Konfiguration](#konfiguration) und [OpenCloud](#opencloud-der-ordner-für-die-predigten)).
   Solange dort `CHANGE-ME` steht, startet der Container nicht.
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
data/einsatzplan.xlsx      Einsatzplan (Mischer, Beamer, Musikteam): zuletzt aus OpenCloud gelesene Kopie (ohne cloud.plan: vom Admin hochgeladen)
data/settings.json         gemeinsame Einstellungen (vom Admin)
data/marks.json            je veröffentlichter Predigt: schon mit der App bearbeitet? fehlende Angaben? (aus den Dateien gelesen, wird neu aufgebaut)
data/original/             die zuerst veröffentlichte Fassung nachbearbeiteter Predigten (Sicherung, nicht veröffentlicht)
data/tmp/                  Uploads, während sie ankommen (wird beim Start geleert)
data/.session-secret       Schlüssel für die Anmelde-Cookies (wird automatisch angelegt)
```

Die veröffentlichten Predigten liegen nicht hier, sondern im Ordner in OpenCloud (nur ohne `cloud` in der Konfiguration, z. B. beim
Entwickeln, in `data/predigten/`).

Auf dem NAS ist das `/volume1/docker/mischer/data/` (File Station: `docker` → `mischer` → `data`). Die Dateien entstehen erst bei Bedarf:
`settings.json` beim ersten Speichern der Einstellungen. Eine `termine.xlsx` aus früheren Versionen wird nicht mehr benutzt und kann
gelöscht werden. Dateien mit Punkt am Anfang (`.session-secret`) zeigt File Station nur an, wenn „Versteckte Dateien anzeigen“ aktiv ist.

### Gut zu wissen

- **Port nur für den Reverse-Proxy:** Die Compose-Datei bindet `9120` an `127.0.0.1`, also ist er nur vom NAS selbst erreichbar,
  nicht aus dem Netz und nicht über den Router. Wer den Proxy umgehen kann, könnte die Kopfzeile `X-Forwarded-For` fälschen und
  die Sperre nach Fehlversuchen aushebeln. Deshalb diese Bindung beibehalten und den Port nicht am Router weiterleiten.
- **`settings.json` von Hand ändern:** Ist die Datei danach kein gültiges JSON mehr, nutzt der Server sie nicht und überschreibt
  sie auch nicht. Die App meldet das beim Speichern; bis zur Reparatur gelten die Werte im jeweiligen Browser.
- **Erste Einrichtung:** Als `admin` in Predigt-Schnitt ⚙ Einstellungen einmal Gemeinde, Prediger, Namensschema, Lautheit, Format und Cover
  prüfen und *Speichern* – erst dann gelten sie für `mischer` (bis dahin nutzt dessen Browser die Standardwerte).
- **Sichern:** den Ordner `data` mitsichern (z. B. Hyper Backup). Wiederherstellen = Ordner zurückkopieren.
- **Abmelden** löscht nur das Cookie dieses Browsers. Alle Anmeldungen eines Benutzers werden ungültig, wenn sein Passwort in der
  `config.json` geändert wird (Container neu starten).
- **Safari (iPad/iPhone)** löscht lokal gespeicherte Daten von Webseiten nach etwa 7 Tagen ohne Nutzung: Das Kürzel muss dann neu
  eingetragen werden; die Anmeldung selbst bleibt (sie liegt im Server-Cookie).
- **Upload-Größe:** Der Server schreibt eine Datei beim Hochladen gleich auf die Platte (`data/tmp/`) und reicht sie dann an OpenCloud
  weiter. Grenze: `maxUploadMb` (Standard 150).
- **Langsame oder wackelige Leitung zu OpenCloud:** Dateien ab 1 MB gehen in Stücken von 4 MB nach OpenCloud (TUS-Protokoll); ein
  Stück, das scheitert oder 2 Minuten hängt, wird bis zu 5-mal neu geschickt – ab der Stelle, die OpenCloud schon hat. Dauert das
  Weiterreichen länger als 20 s, antwortet der Server sofort („angekommen“) und erledigt den Rest im Hintergrund; die Seite zeigt
  den Fortschritt („Wird in OpenCloud gespeichert … 45 %“), bis die Datei dort ist (oder meldet den Fehler). So bricht der Reverse-Proxy
  von DSM (60 s) nichts ab. Beim Stapel geht es mit der nächsten Datei weiter, sobald der Server die vorige hat. Beim Ersetzen nimmt der
  Server als Sicherung die Kopie, die beim Öffnen in *Predigt nachbearbeiten* durch ihn lief (wenn OpenCloud noch dieselbe Fassung hat) –
  die Datei muss nicht noch einmal heruntergeladen werden. Fehlschläge stehen im Protokoll als „OpenCloud: <datei>: … (nach … s)“.
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
  },
  "cloud": {
    "url":   "https://cloud.example.org/remote.php/dav/spaces/…/",
    "user":  "…",
    "token": "…",
    "plan":     "https://cloud.example.org/remote.php/dav/spaces/…/Musik/Musik_Mischer_Beamer.xlsx",
    "overview": "https://cloud.example.org/remote.php/dav/spaces/…/Allgemein/eAg_Übersicht.xlsx"
  }
}
```

- Passwörter mindestens 8 Zeichen, für beide verschieden. Platzhalter (`CHANGE-ME…`) werden abgelehnt.
- Statt Klartext geht auch ein Hash: `npm run hash-password -- 'mein passwort'` (oder im Container
  `node dist-server/hash-password.mjs 'mein passwort'`) und die Ausgabe (`scrypt$…`) als Passwort eintragen.
- Nach einer Änderung den Container neu starten; alle Anmeldungen des geänderten Benutzers werden dabei ungültig.
- `cloud`: der Ordner in OpenCloud, in dem die Predigten veröffentlicht werden (siehe [OpenCloud](#opencloud-der-ordner-für-die-predigten)).
  Ohne diesen Abschnitt speichert der Server sie in `data/predigten/` (zum Entwickeln und Testen).
- Optional: `"sessionDays": 30`, `"maxUploadMb": 150`, `"secureCookies": true`, `"sessionSecret": "…"` (mind. 16 Zeichen).
- Der Pfad der Datei kann über die Umgebungsvariable `CONFIG_FILE` geändert werden (Standard `/config/config.json`);
  weitere Variablen: `DATA_DIR` (`/data`), `STATIC_DIR` (`/app/dist`), `PORT` (`8080`).

## Termine

**Termine und Antworten stehen im Einsatzplan in OpenCloud** (`Musik_Mischer_Beamer.xlsx`, siehe
[Einsatzplan](#einsatzplan-auf-der-startseite)); die App hat keine eigene Tabelle. Jeder Gottesdienst-Termin dort (ohne „kein eAg“) ist
ein Termin der App, mit Mischer, Beamer, Musikteam, Besonderheiten und Bemerkungen aus der Tabelle. Neue Termine kommen in die Tabelle.

- **Antworten:** Jede Person sagt mit ihrem Kürzel (oben eintragen, bleibt im Browser; Vorschläge und Name aus der Legende der Tabelle),
  ob sie mischen kann. Der Server trägt das in der Zeile des Termins ein – nur diese Zellen, der Rest der Tabelle bleibt:

  | Antwort | Eintrag |
  | --- | --- |
  | Ja | `JD` in „Mischer möglich“ |
  | Vielleicht | `JD?` in „Mischer möglich“ |
  | Nein | `JD` in „nicht möglich“ (die Spalte direkt nach „Mischer möglich“, nicht die des Beamers) |
  | zurückgenommen | `JD` aus beiden entfernt |

  Was dort schon steht (andere Kürzel, Text), bleibt erhalten; als Antwort zählen nur Kürzel in Großbuchstaben. Was jemand von Hand in
  die Tabelle schreibt, zeigt die App genauso an.
- Alle sehen, wer was geantwortet hat und wer noch offen ist; sagt der eingeteilte Mischer ab, wird das markiert.
- **Admin:** ✎ neben dem Mischer trägt ihn in die Tabelle ein (wie auf der Startseite).
- Ist die Tabelle gerade in OpenCloud zum Bearbeiten geöffnet oder OpenCloud nicht erreichbar, meldet die App, dass die Antwort nicht
  eingetragen werden konnte. Gleichzeitige Antworten gehen nicht verloren (der Server schreibt nacheinander und prüft, ob die Tabelle
  inzwischen geändert wurde). OpenCloud behält frühere Fassungen der Tabelle.
- Angezeigt werden alle kommenden Termine, vergangene per „Ältere anzeigen“. Die Liste aktualisiert sich jede Minute.
- Wer mit welchem Kürzel antwortet, wird nicht geprüft – gedacht für ein kleines, vertrautes Team.

## Einsatzplan auf der Startseite

Der Einsatzplan ist die Excel-Tabelle der Gemeinde **in OpenCloud** (`Musik_Mischer_Beamer.xlsx`, in der Konfiguration `cloud.plan`).
Der Server liest sie von dort, fragt alle zwei Minuten nach Änderungen (lädt sie aber nur neu, wenn sie sich geändert hat) und behält
die zuletzt gelesene Fassung als `data/einsatzplan.xlsx`. Kann OpenCloud gerade nicht gelesen werden, zeigt die Startseite diese
Fassung mit einem Hinweis. *↻ Aus OpenCloud aktualisieren* (Admin) liest sofort neu.

Gelesen wird nur das **erste Blatt**: Die Spalten werden an ihrer Überschrift erkannt (`Datum`, `Musikteam`, `Teamleitung`,
`Mischer`, `Beamer`, optional `Besonderheiten` und `Bemerkungen`), ihre Reihenfolge und weitere Spalten sind egal.

- **Mischer eintragen (Admin):** ✎ neben dem Mischer eines Termins (Startseite oder Termine), Kürzel eingeben (Vorschläge aus der
  Legende; ein Kürzel, das nicht in der Legende steht, wird als möglicher Tippfehler angezeigt; leer = niemand).
  Der Server schreibt es in die Tabelle in OpenCloud – **nur diese eine Zelle**; Formatierung, andere Spalten und Blätter bleiben,
  wie sie sind. Hat jemand die Tabelle gerade gespeichert, trägt der Server es in dessen Fassung ein (nichts geht verloren); ist sie
  in OpenCloud gerade zum Bearbeiten geöffnet, meldet die App das. Zellen mit Formel werden nicht überschrieben. OpenCloud behält
  die früheren Fassungen (Versionen).
- Termine mit „kein eAg“ (in Musikteam, Teamleitung, Mischer, Beamer oder Besonderheiten) werden ausgeblendet.
- Zeilen ohne Datum unter den Terminen dürfen eine Legende enthalten: Kürzel und daneben der volle Name (`KL | Udo Klaus`).
  Angemeldete sehen dann Namen statt Kürzel.
- **Ohne Anmeldung** zeigt die Startseite die nächsten drei Termine – nur mit Kürzeln, ohne Namen und Bemerkungen.
  **Angemeldet** stehen die nächsten zwei Termine groß oben, alle weiteren (auch vergangene) hinter *Alle Termine anzeigen*.
- Ohne `cloud.plan` lädt der Admin die Tabelle mit *⬆ Plan importieren* hoch; ein neuer Import ersetzt den alten Plan (eine Datei ohne
  die Spalten „Datum“ und „Mischer“ wird abgelehnt), und der Mischer wird in `data/einsatzplan.xlsx` eingetragen.
- Die App **Termine** zeigt genau die Termine dieser Tabelle.

## eAg-Übersicht: Angaben für die MP3

Aus der Tabelle `eAg_Übersicht.xlsx` in OpenCloud (`cloud.overview`, ein Blatt pro Jahr) liest der Server je Termin **Spalte A**
(Datum), **G** (Predigtreihe) und **K** (Prediger/in). Daraus füllt der Export die Angaben vor, sobald das Datum feststeht:

- die Angaben der MP3 nach der Tabelle unten; die Nummer ist die wievielte Predigt der Reihe, nach Datum gezählt (kommt ein
  Reihenname nach mehr als zwei Monaten wieder, zählt er neu ab 1).
- Was von Hand eingetragen wurde, bleibt; ohne Eintrag für das Datum gelten die Vorgaben aus den Einstellungen.
- Ein Datum zählt aus dem Blatt seines Jahres (die Blätter überschneiden sich am Jahreswechsel); gibt es kein solches Blatt, aus dem
  vorigen. Der Server fragt alle fünf Minuten nach Änderungen.
- Im Namensschema gibt es dafür `{reihe}` und `{nr}`.
- *Predigt nachbearbeiten* setzt die Angaben nach denselben Regeln, mit dem Datum aus dem Dateinamen (`predigt-eag-260628` →
  28.06.2026) – auch beim Stapel (siehe dort, *Angaben der MP3*).

### Angaben der MP3

Dieselben Regeln beim Export und beim Nachbearbeiten (`apps/predigt-schnitt/src/tagging.ts`):

| Angabe (ID3) | Inhalt | Woher |
| --- | --- | --- |
| Titel (TIT2) | `Zeit - 04`; ohne Predigtreihe `Predigt vom 18.10.2026` | eAg-Übersicht (Reihe und Nr.); „Titel ohne Predigtreihe“ in den Einstellungen |
| Interpret (TPE1) | Prediger/in | eAg-Übersicht, Spalte K; sonst die Vorgabe aus den Einstellungen |
| Album-Interpret (TPE2) | `Predigt eAg` | Einstellungen – fasst alle Predigten in Playern und Podcast-Apps zusammen |
| Album (TALB) | Predigtreihe, z. B. `Zeit`; ohne Reihe `Predigt eAg` | eAg-Übersicht, Spalte G; sonst „Album ohne Predigtreihe“ bzw. der Album-Interpret |
| Track (TRCK) | Nummer in der Reihe | aus den Daten der eAg-Übersicht gezählt |
| Genre (TCON) | `Predigt` | Einstellungen |
| Jahr, Datum (TYER, TDAT) | 2026, 18.10. | Datum des Gottesdienstes |
| Kommentar (COMM) | `Lk 18,1-8 · 18.10.2026` | Bibelstelle (im Export eingetragen) und Datum |
| Cover (APIC) | eAg-Logo, 1400 × 1400 px | eigenes Bild aus den Einstellungen, sonst `apps/predigt-schnitt/src/cover/` (neu erzeugen mit `scripts/make-cover.sh`) |
| Mischer-App (TXXX) | `bearbeitet 24.10.2026 · -19 LUFS · Hall & Rauschen 18 dB · Kompression` | Markierung: mit der App bearbeitet, siehe [Nachbearbeiten](#predigt-nachbearbeiten-nur-admin) |

Album-Interpret, Genre, „Titel ohne Predigtreihe“, „Album ohne Predigtreihe“ und die Prediger-Vorgabe stellt der Admin in
Predigt-Schnitt unter ⚙ Einstellungen → *Dateiname & Tags* ein.

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
(zum Zurücksetzen löschen; der Ordner ist in `.gitignore`), veröffentlichte Predigten in `uploads-dev/predigten/`.
Mit einer OpenCloud zum Testen: `scripts/cloud-testserver.sh` startet eine in Docker, eingerichtet wie die echte (ein für einen
zweiten Benutzer freigegebener Ordner, App-Token), und gibt den Aufruf `CLOUD_URL=… CLOUD_USER=… CLOUD_TOKEN=… npm run dev` aus.

Den echten Server samt Image lokal ausprobieren:

```sh
docker build -t mischer-app .
mkdir -p /tmp/mischer/config /tmp/mischer/data && chmod 777 /tmp/mischer/data
cp config.example.json /tmp/mischer/config/config.json     # Passwörter eintragen, „cloud“ ausfüllen oder löschen!
docker run --rm -p 9120:8080 -v /tmp/mischer/config:/config:ro -v /tmp/mischer/data:/data mischer-app
```

Die API (alle unter `/api`, Anmeldung per Cookie): `POST login` / `logout`, `GET me`, `POST termine` (`{ "date", "sign", "answer": "yes"|"maybe"|"no"|null }`: Antwort in den Einsatzplan, nur dessen Daten),
`GET plan` (auch ohne Anmeldung, dann gekürzt – ohne Namen, Bemerkungen und Antworten; `source`: `OpenCloud`/`NAS`,
`syncError`), `POST plan/import` (Admin, die xlsx als Body; `409`, wenn der Plan aus OpenCloud kommt), `POST plan/refresh` (Admin),
`POST plan/mischer` (Admin, `{ "date": "2026-11-01", "mischer": "JD" }`; `404` Datum fehlt, `409` gleichzeitig geändert, `423` gesperrt),
`GET overview?date=2026-11-01` (eAg-Übersicht: `series`, `index`, `preacher`), `GET`/`PUT settings/<app>` (PUT: Admin), `POST upload?name=<datei>.mp3` (veröffentlicht die MP3 aus dem Body, `Content-Type: audio/mpeg`), `GET published?name=<datei>.mp3` (`{ "exists": … }`, für alle Angemeldeten),
`GET uploads` (Admin: die veröffentlichten Dateien; je Datei `original: true`, wenn sie schon ersetzt wurde), `GET uploads/<datei>.mp3` (Admin, mit `?original=1` die zuerst
veröffentlichte Fassung), `PUT uploads/<datei>.mp3` (Admin: ersetzt eine veröffentlichte Datei, die MP3 als Body), `GET health`. `GET me` und `POST login`
nennen in `target` das Ziel (`OpenCloud`, ohne Konfiguration `NAS`). Fehlercodes des Uploads: `401` nicht angemeldet, `400` ungültiger Name,
`409` Datei existiert schon, `413` zu groß, `415` keine MP3, `502` OpenCloud hat abgelehnt (Text: `cloud 401` Token falsch/abgelaufen,
`cloud 404` Ordner fehlt, `cloud unreachable` …).

## Ablauf in der App

1. **Laden** – MP3 hineinziehen. Die Datei wird einmal komplett dekodiert (Web Worker, mpg123/WASM):
   Wellenform-Peaks, Merkmale für die Erkennung und ein Frame-Index für exaktes Springen.
2. **Schnitt** – Vorschlag für Start/Ende als orange Region; Übersicht mit Sprache/Musik/Stille,
   Alternativ-Vorschläge, Vorhören, Feinjustieren (Tastatur: Leertaste, S/E, ←/→, Umschalt, P).
3. **Veröffentlichen** – Titel, Prediger, Datum, Bibelstelle und Dateiname eintragen (Schema `predigt-eag-{jjmmdd}`,
   z. B. `predigt-eag-260712.mp3`); Titel, Album (Predigtreihe) und Prediger kommen vorausgefüllt aus der
   [eAg-Übersicht](#eag-übersicht-angaben-für-die-mp3), das Cover ist das eAg-Logo. Lautheit und Klang werden automatisch nach den Voreinstellungen des Admins
   angepasst (Standard: −19 LUFS, höchstens +55 dB Anhebung, Hochpass 80 Hz, sanfte Kompression 2:1, Hall &
   Rauschen reduzieren, „Sprache hoch“ = Mono 96 kbps, 0,5 s Ausblenden – die Predigt endet meist mit „Amen“);
   Messung und MP3-Kodierung laufen schon im Hintergrund, während die Angaben ausgefüllt werden. **⬆ Veröffentlichen**
   schreibt dann die Angaben (Tags) hinein und lädt die Datei mit Fortschritt hoch – der Server legt sie im Ordner in OpenCloud ab;
   *⬇ Nur herunterladen* speichert sie stattdessen auf dem Rechner. Ist der Dateiname schon vergeben, sagt die App das gleich beim
   Ausfüllen (nicht erst nach der Arbeit): `mischer` kann dann nicht veröffentlichen (ist es dieselbe Predigt, ist nichts zu tun),
   der Admin kann *⬆ Ersetzen*. Vorhandene Dateien werden sonst nie überschrieben. Fehlt der Prediger, wird das Feld markiert. **⚙ Erweitert** zeigt
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

## Predigt nachbearbeiten (nur Admin)

Für Predigten, die schon veröffentlicht sind, z. B. ältere Aufnahmen von vor der Hall- und Rauschreduzierung.
Die Kachel sieht nur der Admin; der Server lässt nur ihn zu.

1. **Predigten wählen** – zwei Quellen:
   - *Veröffentlicht:* Liste aller Dateien im Ordner in OpenCloud (Suche nach Namensteil, z. B. `2606`), *Bearbeiten* lädt eine davon.
     Mehrere ankreuzen (oder *Alle auswählen*) und **„… ausgewählte bearbeiten und ersetzen“**: Sie laufen nacheinander mit den
     Einstellungen aus Schritt 2 durch und ersetzen die Dateien in OpenCloud (eine Rückfrage für alle; Status je Zeile);
     *⬇* lädt sie herunter (bei nachbearbeiteten auch *⬇ erste Fassung*, als `…-original.mp3`).
   - *Vom Rechner:* MP3-Dateien hineinziehen oder auswählen, auch mehrere auf einmal. Jede einzeln *Bearbeiten* oder
     **Alle nacheinander bearbeiten und veröffentlichen**: Die Dateien laufen dann ohne weiteres Zutun mit den Einstellungen aus
     Schritt 2 durch und landen in OpenCloud (Status je Datei in der Liste, *Nach dieser Datei anhalten* möglich).
     Veröffentlicht wird unter dem Dateinamen, bereinigt (`predigt-eag-261018(1).mp3` → `predigt-eag-261018-1.mp3`).
2. **Bearbeitung** – Lautheit, Format, Ein-/Ausblenden, Hochpass, Kompression, Hall & Rauschen für alle Dateien auf der Seite.
   Voreingestellt sind die Standardwerte von Predigt-Schnitt (auch 0,5 s Ein- und Ausblenden); Änderungen gelten nur hier,
   die Standardwerte bleiben unverändert. Dazu **Angaben der MP3**:
   - *automatisch* (Standard): wie beim Export ([Angaben der MP3](#angaben-der-mp3)) mit dem Datum aus dem Dateinamen – was die
     eAg-Übersicht weiß, gilt; die Datei behält ihre eigenen Angaben nur, wo dort nichts steht (ein bloßes „Predigt“ als Titel zählt
     nicht); Album-Interpret und Genre aus den Einstellungen.
   - *aus der Datei übernehmen*: die Angaben der Datei bleiben, nur fehlende werden ergänzt.
3. **Datei** – die ganze Datei (kein Schnitt). Titel, Prediger/in, Album, Nr. in der Reihe, Album-Interpret, Genre, Datum und
   Kommentar stehen nach Schritt 2 in den Feldern und können geändert werden; Dateien ohne Cover bekommen das eAg-Cover (bzw. das aus
   den Einstellungen). Hat eine Datei vom Rechner keine Tags, gelten die der gleichnamigen veröffentlichten Datei als ihre eigenen. Die Berechnung startet sofort im Hintergrund
   (15 min Predigt ≈ 45 s, 26 min ≈ 75 s auf einem 12-Kern-PC, mit Entrauschen). *MP3 erstellen*, vorher/nachher anhören, dann
   veröffentlichen oder herunterladen.

**Nur Angaben:** Der Knopf *Nur Angaben* (bei veröffentlichten und bei MP3-Dateien vom Rechner) ändert nur Titel, Prediger/in,
Datum usw. – das Audio bleibt Byte für Byte, wie es ist, nichts wird neu bearbeitet oder kodiert, und eine vorhandene Markierung bleibt.
Bei veröffentlichten Dateien nimmt er immer die aktuelle Fassung (nicht die erste, die oft noch unbearbeitet ist). Geht sofort, auch bei
schon bearbeiteten Dateien.

**Fehlende Angaben:** Beide Listen zeigen „fehlt: Prediger/in, Datum …“ bei Dateien, deren Tag eine Pflichtangabe fehlt.
Ohne Titel, Prediger/in und Datum wird nichts veröffentlicht – auch nicht einzeln (die App sagt, was fehlt).
Der Stapel (beide Quellen) nimmt im Modus *automatisch* nur Dateien, deren Datum im Dateinamen steht und die die eAg-Übersicht kennt;
die anderen markiert er gleich zu Beginn als „nur einzeln: … nicht in der eAg-Übersicht“ (bzw. „kein Datum im Dateinamen“) und lässt
sie aus, ebenso eine Datei, bei der nach dem Laden noch eine Pflichtangabe fehlt. Einzeln bearbeitet zeigt der Editor bei solchen
Dateien einen Hinweis, die Angaben von Hand zu prüfen. Ist die eAg-Übersicht gar nicht erreichbar, startet der Stapel nicht.
Im Modus *aus der Datei übernehmen* zählt nur, ob die Pflichtangaben da sind.

**Schon bearbeitet:** Jede MP3 der App trägt eine Markierung (Angabe „Mischer-App“, siehe [Angaben der MP3](#angaben-der-mp3)).
Solche Dateien zeigt die Liste als „schon bearbeitet“ – bei nachbearbeiteten zählt die erste Fassung, von der aus neu bearbeitet
wird. „Alle auswählen“ und der Stapel vom Rechner lassen sie aus; einzeln bearbeiten geht nach einer Rückfrage. Noch einmal bearbeiten
würde Hall und Rauschen doppelt reduzieren (die Stimme wird dünner) und die MP3 ein zweites Mal kodieren. Der Server liest die
Markierung beim Auflisten aus dem Anfang jeder Datei und merkt sich das Ergebnis pro Version in `data/marks.json`.
Dateien ohne Markierung, die doch schon bearbeitet sind, markiert `npm run mark-processed -- config.json --write` (im Container
`node dist-server/mark-processed.mjs --write`; ohne `--write` wird nur gezählt); mit `--note "bearbeitet 24.10.2026 · …"` bekommen alle
Dateien genau diesen Text, eine andere Markierung wird ersetzt. Nur das Tag ändert sich, das Audio bleibt Byte für Byte.

**Ersetzen:** Gibt es in OpenCloud schon eine Datei mit dem Namen, wird sie ersetzt (die App fragt vorher, beim Stapel einmal für alle);
sonst kommt eine neue dazu. Vor dem ersten Ersetzen sichert der Server die bisherige Datei auf dem NAS in `data/original/`;
spätere Durchgänge überschreiben nur die aktuelle Fassung. Die Liste markiert solche Dateien mit „nachbearbeitet“, und ein
erneutes Bearbeiten startet von der ersten Fassung (nicht doppelt gefiltert); die aktuelle lässt sich per Knopf stattdessen laden.
OpenCloud behält außerdem selbst die früheren Versionen (in OpenCloud: Datei → Details → Versionen). Zurück zur ersten Fassung:
dort die Version wiederherstellen, oder *⬇ erste Fassung* herunterladen und in OpenCloud hochladen.

## OpenCloud: der Ordner für die Predigten

Veröffentlicht wird in **einen gemeinsamen Ordner in OpenCloud**; er ist der einzige Ort der veröffentlichten Predigten, andere lesen
dort mit. Der Server auf dem NAS schreibt hinein (WebDAV) – nicht der Browser, deshalb braucht es in OpenCloud keine Einstellungen
eines Admins (CORS). Kopiert wird nur beim Veröffentlichen (Upload in Predigt-Schnitt, Speichern in Predigt nachbearbeiten),
es gibt keinen Abgleich im Hintergrund. Was in OpenCloud gelöscht oder umbenannt wird, sieht die App sofort so.

Der Server meldet sich mit einem **App-Token** eines Benutzers an, der im Ordner schreiben darf (Anmeldung über ChurchTools
geht für Programme nicht; ein App-Token ist ein Passwort nur für diesen Zweck):

1. **App-Token:** In OpenCloud oben rechts → *Einstellungen* (Konto) → *App-Tokens* → *+ Neu*, Name z. B. „Mischer-App“, Ablaufdatum
   wählen. Das Token (mehrere Wörter) wird nur einmal angezeigt – gleich kopieren. Achtung: Es gilt für das ganze Konto, nicht nur
   für den Ordner; und es bleibt gültig, bis es abläuft oder gelöscht wird (auch wenn das Konto in ChurchTools gesperrt wird).
   Vor dem Ablaufdatum ein neues anlegen und eintragen.
2. **WebDAV-Adresse des Ordners:** In den Konto-Einstellungen *WebDAV-Informationen in der Detailansicht anzeigen* einschalten. Dann
   den Ordner auswählen (bei einem freigegebenen Ordner unter *Mit mir geteilt*), die Details (ⓘ) öffnen und unter *WebDAV* die
   Adresse kopieren (`https://…/dav/spaces/…`).
3. **In `config.json` eintragen:** `"cloud": { "url": "<WebDAV-Adresse>", "user": "<OpenCloud-Benutzername>", "token": "<App-Token>" }`,
   dazu die WebDAV-Adressen der beiden Tabellen als `"plan"` (Musik_Mischer_Beamer.xlsx) und `"overview"` (eAg_Übersicht.xlsx) –
   zu finden wie beim Ordner, oder die Ordner-Adresse plus Pfad (`…/Musik/Musik_Mischer_Beamer.xlsx`). Der Benutzer muss die
   Einsatzplan-Tabelle bearbeiten dürfen.
4. **Prüfen**, am besten vor dem Neu-Deployen: `npm run cloud-check -- pfad/zur/config.json --write` (im Container:
   `node dist-server/cloud-check.mjs --write`). Das listet den Ordner, lädt eine kleine Testdatei hoch und wieder weg und prüft,
   ob die beiden Tabellen erreichbar sind (sie werden dabei nicht verändert).
   Mit `--big` lädt es zusätzlich 20 MB hoch (versteckter Name, danach gelöscht) und zeigt alle 2 s den Fortschritt und am Ende
   die mittlere Geschwindigkeit – um eine langsame Leitung von einer zu unterscheiden, die bei großen Dateien hängen bleibt
   (`--ipv4`: nur über IPv4). Meldet es „Anmeldung abgelehnt (401)“, statt des Benutzernamens die Benutzer-ID (UUID) versuchen – bei Konten, die
   OpenCloud beim ersten Anmelden über ChurchTools selbst anlegt, verlangt OpenCloud sie. Der Server prüft den Zugang auch bei
   jedem Start und schreibt das Ergebnis ins Protokoll („OpenCloud erreichbar …“ oder den Fehler).

Läuft das Token ab, scheitert das Veröffentlichen mit einer Meldung („App-Token vermutlich abgelaufen“); die Datei bleibt im Browser
und lässt sich herunterladen. Dateien, die vorher in `data/predigten/` auf dem NAS lagen, werden nicht automatisch übertragen –
bei Bedarf in Predigt nachbearbeiten über *Vom Rechner* veröffentlichen oder in OpenCloud hochladen.

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
packages/plan/               Einsatzplan aus der Excel-Tabelle der Gemeinde lesen (mit den Antworten), assign.ts: Mischer eintragen, cells.ts: Zellwerte
apps/predigt-schnitt/        Predigt-Schnitt (Schritte unter src/steps/, src/overview.ts: eAg-Übersicht, src/cover/: Standard-Cover)
apps/predigt-nachbearbeiten/ Predigt nachbearbeiten (nur Admin; nutzt die Bausteine von Predigt-Schnitt)
apps/termine/                Termine (src/model.ts: Antworten, src/api.ts: Einsatzplan und Antworten vom/zum Server)
packages/audio-core/         Decoder, Frame-Index, Merkmale, Erkennung, Lautheit, DSP, Pipeline, Worker
packages/denoise/            Hall-/Rauschreduzierung: df3.wasm (DeepFilterNet3 mit Modell) und Wrapper;
                             wasm/ ist der Rust-Quelltext, neu bauen mit wasm/build.sh (nur nach Änderungen nötig)
packages/upload/             Upload zum Server (der veröffentlicht)
packages/settings/           localStorage-Store mit JSON-Export/-Import, gemeinsame Einstellungen vom Server
packages/auth/               Anmeldung am Server (Rollen admin / mischer)
packages/ui-kit/             DOM-Helfer, Styles
server/                      Server: api.ts (Anmeldung, Termine, Einsatzplan, Einstellungen, Upload), sermon-store.ts (OpenCloud per WebDAV),
                             cloud-file.ts (einzelne Dateien in OpenCloud, mit Versionsprüfung), xlsx.ts (Zellen lesen, eine Zelle ändern),
                             plan-store.ts, overview-store.ts, cloud-check.ts, static.ts, main.ts, config.ts, auth.ts
Dockerfile, docker-compose.yml, config.example.json   Betrieb auf dem NAS
scripts/                     bench.ts (Erkennungs-Benchmark), make-synthetic.py, cloud-testserver.sh (OpenCloud zum Testen), make-cover.sh
dev-server.ts                bindet die API in `npm run dev` / `preview` ein
```

Neue App: Ordner unter `apps/`, Eintrag in `apps.json` (mit `"adminOnly": true` nur für den Admin sichtbar) und in `vite.config.ts` (`rollupOptions.input`).

## Bekannte Grenzen / noch offen

- Die Erkennungs-Schwellen sind Startwerte (Phase 5 des Plans); sie müssen mit echten Aufnahmen kalibriert werden.
- Transkript-Verfeinerung (Whisper), PWA/Offline und Stapelverarbeitung sind noch nicht umgesetzt (Phase 7).
- Der Export wird immer mit 44,1 kHz kodiert (48-kHz-Quellen resampelt LAME).
- Die Beispiel-Dateien (`predigt-beispiele.zip`) sind bereits geschnittene Predigten; zum Kalibrieren der
  Erkennung werden die vollständigen Gottesdienst-Mitschnitte gebraucht.
