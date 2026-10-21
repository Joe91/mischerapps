# Planung: Web-App „Predigt-Schnitt“ (GitHub Pages)

> Ziel: Eine rein browserbasierte Web-App, die eine MP3-Aufnahme (z. B. ganzer Gottesdienst) lädt, die Predigt automatisch erkennt und als Schnittvorschlag markiert, Lautheit normalisiert, als MP3 mit passender Bitrate exportiert und auf einen Zielserver hochlädt.
> Die Struktur ist so angelegt, dass später weitere Apps (z. B. Lesungen schneiden, Podcast-Intro anfügen, Liedplan erstellen) im selben Repository und unter derselben Domain laufen.

---

## 0. Wichtigste Entscheidungen vorab

| Thema | Entscheidung | Begründung |
|---|---|---|
| Hosting | GitHub Pages (statisch) | kostenlos, einfach, HTTPS inklusive |
| Verarbeitung | komplett im Browser (Web Audio, WebAssembly, Web Worker) | keine Serverkosten, Audio verlässt den Rechner erst beim Upload |
| **FTP-Upload** | **Nicht direkt aus dem Browser möglich** → HTTP-Upload-Endpunkt auf dem Zielserver (PHP) oder kleiner Proxy | Browser können keine FTP/SFTP-Verbindungen öffnen (keine rohen TCP-Sockets) |
| Zugangsdaten | Nie im Repository; Upload-Token wird in der App eingegeben und lokal im Browser gespeichert | GitHub-Pages-Repos sind (im Free-Plan) öffentlich |
| Build | Vite + TypeScript, Multi-Page-Setup, Deploy per GitHub Actions | ein Repo, mehrere Apps, gemeinsame Bibliotheken |
| Große Dateien | Streaming-Decoding, nicht die ganze Datei als Float-Array halten | 90 min Stereo/48 kHz als Float32 ≈ 2 GB RAM → Absturz, besonders auf Tablets |

---

## 1. Funktionale Anforderungen

### 1.1 Workflow (5 Schritte, als „Wizard“ in der UI)

1. **Laden** – MP3 per Drag & Drop oder Dateiauswahl (auch mehrere Dateien nacheinander).
2. **Analysieren & Schneiden** – automatische Erkennung von Sprach-/Musik-/Stille-Abschnitten; Vorschlag für Start- und Endmarker der Predigt; manuelle Korrektur in der Wellenform.
3. **Lautheit** – Messung (LUFS) und automatische Gain-Anhebung auf Zielwert, mit Peak-Begrenzung.
4. **Export** – MP3-Kodierung mit Preset (z. B. Sprache Mono 64 kbps), ID3-Tags (Titel, Prediger, Datum, Bibelstelle), automatischer Dateiname.
5. **Upload** – Übertragung auf den Zielserver mit Fortschrittsanzeige; alternativ Download.

### 1.2 Detailanforderungen

| ID | Anforderung | Priorität |
|---|---|---|
| F1 | MP3 bis mind. 120 min / 200 MB laden | Muss |
| F2 | Wellenform mit Zoom, Scrollen, Abspielen ab Klickposition | Muss |
| F3 | Automatische Segmentierung (Stille / Musik / Sprache) | Muss |
| F4 | Vorschlag Start/Ende Predigt, als verschiebbare Marker | Muss |
| F5 | Marker per Tastatur feinjustieren (±0,1 s / ±1 s), „Vorhören“ 5 s um Marker | Muss |
| F6 | Ein-/Ausblenden (Fade, z. B. 0,5 s / 1,5 s) | Soll |
| F7 | Lautheitsnormalisierung auf Ziel-LUFS mit True-Peak-Grenze | Muss |
| F8 | Optional: Hochpass 80 Hz (Trittschall, Brummen) | Soll |
| F9 | MP3-Export mit Bitrate-Presets | Muss |
| F10 | ID3-Tags | Soll |
| F11 | Upload auf Zielserver mit Fortschritt und Fehlermeldung | Muss |
| F12 | Einstellungen (Zielserver, Token, Presets, Namensschema) lokal speichern, als JSON exportieren/importieren | Soll |
| F13 | Optional: Transkript-basierte Markerverfeinerung (Kanzelgruß / Kanzelsegen erkennen) | Kann (Phase 3) |
| F14 | Offline nutzbar (PWA) | Kann |

### 1.3 Nicht-funktionale Anforderungen

- **Datenschutz:** Keine Audiodaten an Dritte; keine Analyse-/Tracking-Skripte; alle Bibliotheken lokal gebündelt (kein CDN zur Laufzeit).
- **Browser:** aktuelle Chrome/Edge/Firefox/Safari (Desktop). Tablets „best effort“.
- **Bedienbarkeit:** Ein Durchlauf (Upload bis Upload) in < 3 Minuten für den Normalfall; Bedienung ohne Audiokenntnisse.
- **Performance:** Rechenintensives (Decoding, Analyse, Encoding) in Web Workern, UI bleibt flüssig.

---

## 2. Architektur

### 2.1 Repository-Struktur (Monorepo für mehrere Apps)

```
audio-tools/
├─ index.html                 # Startseite: Kachelübersicht aller Apps
├─ apps.json                  # Registry: Name, Pfad, Beschreibung, Icon
├─ apps/
│  ├─ predigt-schnitt/
│  │  ├─ index.html
│  │  └─ src/
│  │     ├─ main.ts
│  │     ├─ steps/            # load.ts, cut.ts, loudness.ts, export.ts, upload.ts
│  │     └─ ui/
│  └─ (spätere Apps, z. B. lesung-schnitt/, intro-outro/)
├─ packages/                  # gemeinsam genutzter Code
│  ├─ audio-core/
│  │  ├─ decode.worker.ts     # Streaming-Decoding (mpg123-decoder)
│  │  ├─ analysis.ts          # Features, Segmentierung, Markervorschlag
│  │  ├─ loudness.ts          # EBU R128 / LUFS
│  │  ├─ dsp.ts               # Gain, Limiter, Fades, Hochpass
│  │  └─ encode.worker.ts     # MP3-Encoder
│  ├─ upload/
│  │  └─ http-upload.ts       # XHR mit Fortschritt, Ziel-Profile
│  ├─ settings/               # localStorage-Wrapper, Export/Import JSON
│  └─ ui-kit/                 # Wizard, Buttons, Fortschrittsbalken, Styles
├─ server/                    # NICHT auf Pages – Vorlagen für den Zielserver
│  ├─ upload.php
│  └─ proxy-node/             # optional: HTTP→FTP/SFTP-Proxy
├─ vite.config.ts
├─ package.json
└─ .github/workflows/deploy.yml
```

### 2.2 Technologie-Stack

| Zweck | Bibliothek | Hinweis |
|---|---|---|
| Build / Dev-Server | **Vite** + TypeScript | Multi-Page über `build.rollupOptions.input` |
| UI | Vanilla TS oder **Svelte** | leichtgewichtig; Svelte erleichtert spätere Apps |
| Wellenform + Marker | **wavesurfer.js v7** + Regions- und Timeline-Plugin | mit vorberechneten `peaks` + `<audio>`-Element → kein Voll-Decoding für die Anzeige |
| MP3-Decoding (streaming) | **mpg123-decoder** (WASM, Paket `mpg123-decoder`) | dekodiert blockweise; Alternative: `decodeAudioData` nur für kurze Dateien |
| Spektrale Features | eigene FFT oder **Meyda** | Spectral Flatness, ZCR, RMS |
| MP3-Encoding | **wasm-media-encoders** (LAME als WASM) | schnell, klein; Fallback: `@breezystack/lamejs` (gepflegter lamejs-Fork) |
| ID3-Tags | **browser-id3-writer** | |
| Optional Transkript | **transformers.js** + Whisper (tiny/base, deutsch) | groß (40–150 MB Modell), WebGPU empfohlen → Phase 3 |
| PWA (optional) | vite-plugin-pwa | Offline-Cache |

> **Nicht empfohlen:** ffmpeg.wasm. Die Multithread-Version braucht `SharedArrayBuffer` und damit COOP/COEP-Header, die GitHub Pages nicht setzen kann (nur per Service-Worker-Workaround). Zudem ~30 MB Download. Für diesen Zweck reichen die schlanken Einzel-Bibliotheken.

### 2.3 Datenfluss (speicherschonend)

```
MP3-Datei
  │
  ├─► <audio src=ObjectURL>  ──► Wiedergabe in der UI (Browser dekodiert selbst)
  │
  └─► Decode-Worker (Pass 1, streaming)
        ├─ Downmix mono, Resampling auf 16 kHz → Feature-Frames (RMS, ZCR, Flatness)
        └─ Peaks für Wellenform (z. B. 50 Werte/s)
              │
              ▼
        Analyse → Segmente → Markervorschlag ──► UI (Regionen in wavesurfer)
              │
        Nutzer bestätigt Start/Ende
              ▼
  Decode-Worker (Pass 2, nur Bereich Start–Ende, Originalrate, mono)
        └─ Lautheitsmessung (LUFS, gated) → Gain berechnen
              ▼
  Decode-Worker (Pass 3, gleicher Bereich, streaming)
        └─ Hochpass → Gain → Fades → Limiter → Encoder-Worker (chunkweise) → MP3-Blob
              ▼
        ID3-Tags → Download und/oder Upload
```

Speicherbedarf bleibt so bei wenigen MB für Features plus dem fertigen MP3 (25 min Mono @ 64 kbps ≈ 12 MB). Pass 2 und 3 dekodieren erneut statt zwischenzuspeichern – das kostet wenige Sekunden, spart aber Hunderte MB.

---

## 3. Automatische Marker-Erkennung (Kern der App)

### 3.1 Ausgangslage

Eine Gottesdienstaufnahme besteht typischerweise aus: Orgel/Musik → Liturgie (kurze Sprechpassagen) → Lied → Lesung → Lied → **Predigt (12–30 min, durchgehend Sprache, kurze Pausen)** → Lied → Gebete → Segen → Musik.

Die Predigt ist daher sehr gut erkennbar als **längster zusammenhängender Sprachblock**, eingerahmt von Musik.

### 3.2 Merkmale pro Frame

Analyse auf Mono 16 kHz, Frame 50 ms, Hop 25 ms:

| Merkmal | Sprache | Musik (Orgel/Gesang) | Stille |
|---|---|---|---|
| RMS (dB) | stark schwankend | gleichmäßig hoch | sehr niedrig |
| Pausenanteil (Frames unter Schwelle, Fenster 3 s) | 10–30 % | ~0 % | ~100 % |
| Energiemodulation 2–8 Hz (Silbenrhythmus) | hoch | niedrig | – |
| Spectral Flatness | mittel | niedrig (tonal) | hoch (Rauschen) |
| Zero-Crossing-Rate-Varianz | hoch (Wechsel stimmhaft/stimmlos) | niedrig | – |

### 3.3 Algorithmus (Phase 1, heuristisch)

1. **Adaptive Stilleschwelle:** `noiseFloor = Perzentil10(RMS_dB)`; `silenceThr = noiseFloor + 6 dB`.
2. **Fenstermerkmale** (Fenster 3 s, Schritt 0,5 s): Pausenanteil, RMS-Standardabweichung, mittlere Flatness, 4-Hz-Modulationsenergie.
3. **Sprach-Score** je Fenster als gewichtete Summe normierter Merkmale (Gewichte zunächst von Hand, später mit 5–10 eigenen Aufnahmen kalibrieren).
4. **Glättung:** Median-Filter (≈ 5 s) + Hysterese (Sprache ab Score > 0,6, endet erst bei < 0,4) → verhindert Flattern.
5. **Segmente bilden** und Sprachsegmente zusammenführen, wenn Lücke < 8 s (Atempausen, Blättern).
6. **Kandidat Predigt** = längstes Sprachsegment mit Dauer ≥ 8 min; Tie-Breaker: Musik direkt davor und danach.
7. **Marker einrasten:** Start/Ende auf das nächstgelegene Stille-Minimum in ±3 s verschieben, dann 0,3 s Vorlauf / 0,8 s Nachlauf zugeben.
8. **Konfidenz** (0–1) ausgeben; bei < 0,5 UI-Hinweis „Bitte Marker prüfen“. Die zwei nächstbesten Kandidaten als alternative Vorschläge anbieten.

```ts
// packages/audio-core/analysis.ts (Skizze)
export interface Segment { start: number; end: number; kind: 'speech'|'music'|'silence'; }

export function suggestSermon(segs: Segment[], minDur = 480, mergeGap = 8) {
  const speech = mergeSpeech(segs.filter(s => s.kind === 'speech'), mergeGap);
  const ranked = speech
    .filter(s => s.end - s.start >= minDur)
    .map(s => ({ ...s, score: (s.end - s.start) + musicNeighbourBonus(s, segs) }))
    .sort((a, b) => b.score - a.score);
  return ranked.slice(0, 3); // [Vorschlag, Alternative 1, Alternative 2]
}

function mergeSpeech(list: Segment[], gap: number): Segment[] {
  const out: Segment[] = [];
  for (const s of list) {
    const last = out[out.length - 1];
    if (last && s.start - last.end < gap) last.end = s.end;
    else out.push({ ...s });
  }
  return out;
}
```

### 3.4 Phase 3: Verfeinerung per Transkript (optional)

- Whisper (transformers.js) nur auf **±90 s um die vorgeschlagenen Marker** anwenden → wenige Sekunden Rechenzeit statt Minuten.
- In evangelischen Gottesdiensten typische Rahmenformeln suchen (konfigurierbare Liste):
  - Start: Kanzelgruß („Gnade sei mit euch …“, „Liebe Gemeinde“)
  - Ende: Kanzelsegen („Und der Friede Gottes …“), „Amen“
- Treffer mit Wort-Zeitstempeln → Marker präzise davor/danach setzen.
- Wählbar: Kanzelgruß/Kanzelsegen **mitnehmen oder abschneiden**.

### 3.5 Kalibrierung

Ein kleines Test-Set (5–10 echte Aufnahmen) mit von Hand gesetzten Markern als JSON anlegen. Ein Node-Skript misst die Abweichung der Vorschläge (Ziel: Median < 5 s, nie > 30 s). Damit lassen sich Schwellen und Gewichte nachvollziehbar optimieren.

---

## 4. Lautheit / Gain

### 4.1 Zielwerte (konfigurierbar)

| Preset | Ziel | True Peak | Hinweis |
|---|---|---|---|
| Podcast Mono (Standard) | −19 LUFS | −1,5 dBTP | entspricht im Höreindruck −16 LUFS Stereo |
| Podcast Stereo | −16 LUFS | −1,0 dBTP | übliche Plattform-Empfehlung |
| Leise/Archiv | −23 LUFS | −1,0 dBTP | EBU R128 Rundfunk |

### 4.2 Umsetzung

1. **Messung** nach ITU-R BS.1770 / EBU R128:
   - K-Filter: Hochpass ~38 Hz + High-Shelf +4 dB bei ~1,5 kHz (als Biquad-Kaskade im Worker).
   - Blöcke 400 ms, 75 % Überlappung, absolutes Gate −70 LUFS, relatives Gate −10 LU.
   - Für Prüfung gegen Referenz: Ergebnis mit `ffmpeg -af ebur128` am Desktop vergleichen (Abweichung < 0,5 LU).
2. **Gain** = Ziel − gemessen (Begrenzung z. B. max. +20 dB, damit Rauschen nicht explodiert).
3. **Limiter** mit 5 ms Lookahead, Release ~100 ms, Ceiling = True-Peak-Ziel (4-fach Oversampling für True Peak oder 0,5 dB Sicherheitsabstand bei Sample-Peak).
4. Optional vorgeschaltet: **Hochpass 80 Hz** (Sprache, entfernt Rumpeln) und sanfter Kompressor (2:1) für unterschiedliche Abstände zum Mikrofon.
5. Anzeige: „Gemessen −27,4 LUFS → Anhebung +8,4 dB → Ergebnis −19,0 LUFS“.

```ts
// Gain + einfacher Limiter, blockweise (Skizze)
export function processBlock(x: Float32Array, gainLin: number, lim: Limiter) {
  for (let i = 0; i < x.length; i++) x[i] = lim.next(x[i] * gainLin);
  return x;
}
```

---

## 5. Export

### 5.1 Presets

| Preset | Kanäle | Abtastrate | Bitrate | Größe (30 min) |
|---|---|---|---|---|
| **Sprache Standard** | Mono | 44,1 kHz | 64 kbps CBR | ≈ 14 MB |
| Sprache hoch | Mono | 44,1 kHz | 96 kbps | ≈ 21 MB |
| Mit Musik | Stereo | 44,1 kHz | 128 kbps | ≈ 29 MB |

CBR wählen, weil manche Player/Podcast-Plattformen bei VBR falsche Längen anzeigen.

### 5.2 Encoder im Worker

```ts
// packages/audio-core/encode.worker.ts (Skizze mit wasm-media-encoders)
import { createMp3Encoder } from 'wasm-media-encoders';

let enc: Awaited<ReturnType<typeof createMp3Encoder>>;
const parts: Uint8Array[] = [];

self.onmessage = async (e) => {
  const { type } = e.data;
  if (type === 'init') {
    enc = await createMp3Encoder();
    enc.configure({ sampleRate: e.data.sampleRate, channels: 1, bitrate: e.data.kbps });
  } else if (type === 'chunk') {
    parts.push(enc.encode([e.data.samples]).slice());   // Float32Array je Kanal
  } else if (type === 'finish') {
    parts.push(enc.finalize().slice());
    self.postMessage(new Blob(parts, { type: 'audio/mpeg' }));
  }
};
```

### 5.3 Dateiname und Tags

- Schema konfigurierbar, Standard: `{datum}_{titel-slug}.mp3`, z. B. `2026-10-25_Predigt-Lukas-18.mp3`.
- Datum vorbelegt mit dem letzten Sonntag.
- ID3: Titel, Interpret (Prediger/in), Album (Gemeindename), Jahr, Kommentar (Bibelstelle), optional Cover-Bild (aus Einstellungen).

---

## 6. Upload auf den Zielserver

### 6.1 Das FTP-Problem

Webseiten können aus Sicherheitsgründen **kein FTP, FTPS oder SFTP** sprechen. Es gibt daher vier Wege – empfohlen ist **A**, sofern der Webspace PHP kann (bei fast allen Hostern der Fall).

| Variante | Aufwand | Voraussetzung | Bewertung |
|---|---|---|---|
| **A: PHP-Upload-Skript** auf dem Zielserver | gering | Webspace mit PHP | **empfohlen** |
| B: WebDAV (z. B. Nextcloud) per HTTP `PUT` | gering | WebDAV + CORS erlaubt | gut, falls Nextcloud vorhanden |
| C: Eigener Proxy (Node, HTTP → FTP/SFTP) | mittel | kleiner Server/VPS/Raspberry Pi | wenn nur FTP verfügbar ist |
| D: Nur Download, manueller FTP-Upload | keiner | – | Fallback, immer verfügbar |

### 6.2 Variante A – `server/upload.php` (auf dem Zielserver ablegen)

```php
<?php
// Konfiguration
const UPLOAD_TOKEN   = 'HIER-LANGEN-ZUFALLSTOKEN-EINTRAGEN'; // z. B. 40+ Zeichen
const ALLOWED_ORIGIN = 'https://DEIN-NAME.github.io';
const TARGET_DIR     = __DIR__ . '/../predigten/';
const MAX_BYTES      = 80 * 1024 * 1024;

header('Access-Control-Allow-Origin: ' . ALLOWED_ORIGIN);
header('Access-Control-Allow-Headers: X-Upload-Token');
header('Access-Control-Allow-Methods: POST, OPTIONS');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }
if ($_SERVER['REQUEST_METHOD'] !== 'POST')    { http_response_code(405); exit; }

// Eigener Header, da "Authorization" bei manchen Hostern (CGI) verschluckt wird
if (!hash_equals(UPLOAD_TOKEN, $_SERVER['HTTP_X_UPLOAD_TOKEN'] ?? '')) {
  http_response_code(401); exit('unauthorized');
}

$f = $_FILES['file'] ?? null;
if (!$f || $f['error'] !== UPLOAD_ERR_OK) { http_response_code(400); exit('upload error'); }
if ($f['size'] > MAX_BYTES)               { http_response_code(413); exit('too large'); }

$name = basename($f['name']);
if (!preg_match('/^[A-Za-z0-9._-]{1,120}\.mp3$/', $name)) { http_response_code(400); exit('bad name'); }

$finfo = new finfo(FILEINFO_MIME_TYPE);
if (!in_array($finfo->file($f['tmp_name']), ['audio/mpeg', 'audio/mp3'], true)) {
  http_response_code(415); exit('not mp3');
}

if (!is_dir(TARGET_DIR)) mkdir(TARGET_DIR, 0755, true);
$dest = TARGET_DIR . $name;
if (file_exists($dest)) { http_response_code(409); exit('exists'); }

if (!move_uploaded_file($f['tmp_name'], $dest)) { http_response_code(500); exit('move failed'); }
header('Content-Type: application/json');
echo json_encode(['ok' => true, 'file' => $name]);
```

Hinweise:
- Beim Hoster prüfen: `upload_max_filesize` und `post_max_size` ≥ 80 MB (ggf. per `.user.ini`).
- Zielordner außerhalb ausführbarer Pfade halten bzw. per `.htaccess` PHP-Ausführung darin verbieten.
- Optional: zusätzlich eine JSON-/RSS-Datei aktualisieren (Grundlage für einen Predigt-Podcast).

### 6.3 Client-Seite (mit Fortschritt)

```ts
// packages/upload/http-upload.ts
export function uploadFile(url: string, token: string, file: Blob, name: string,
                           onProgress: (p: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file, name);
    const xhr = new XMLHttpRequest();            // XHR, weil fetch keinen Upload-Fortschritt liefert
    xhr.open('POST', url);
    xhr.setRequestHeader('X-Upload-Token', token);
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload  = () => xhr.status < 300 ? resolve(xhr.responseText)
                                         : reject(new Error(`${xhr.status}: ${xhr.responseText}`));
    xhr.onerror = () => reject(new Error('Netzwerkfehler oder CORS blockiert'));
    xhr.send(fd);
  });
}
```

### 6.4 Variante C – Proxy (nur falls ausschließlich FTP/SFTP verfügbar)

- Kleiner Node-Dienst (Express + `basic-ftp` bzw. `ssh2-sftp-client`) nimmt den HTTP-Upload wie in 6.2 an und leitet ihn per FTP/SFTP weiter.
- FTP-Zugangsdaten liegen nur als Umgebungsvariablen auf dem Proxy, nie in der Web-App.
- Betrieb z. B. auf vorhandenem Vereins-/Gemeindeserver oder Raspberry Pi mit HTTPS (Caddy).

### 6.5 Zugangsdaten in der App

- Einstellungsseite: Upload-URL + Token, gespeichert in `localStorage` **nur auf dem eigenen Gerät**.
- Mehrere Ziel-Profile möglich (z. B. „Gemeinde-Website“, „Test“).
- Token jederzeit am Server austauschbar; bei Verlust des Geräts einfach neuen Token setzen.
- Einstellungs-Export als JSON **ohne** Token (Option „Token mit exportieren“ bewusst abwählbar).

---

## 7. Benutzeroberfläche

```
┌───────────────────────────────────────────────────────────────┐
│ Predigt-Schnitt      ① Laden ② Schnitt ③ Lautheit ④ Export ⑤ Upload │
├───────────────────────────────────────────────────────────────┤
│ [Timeline 0:00 ─────────────────────────────────── 1:12:40]  │
│ ▁▂▅▇▇▅▂▁▁▃▅▃▂▃▅▆▅▃▂ ▏███████ PREDIGT ███████▕ ▂▅▇▇▅▂▁▁▃▅▃▂▁   │
│  Musik   Liturgie   Lesung      22:14 – 41:57       Musik   │
│ Segmentleiste farbig: ■ Sprache ■ Musik ■ Stille             │
├───────────────────────────────────────────────────────────────┤
│ Start 22:14.3  [◀ −1s][◀ −0.1s][▶ Vorhören][+0.1s ▶][+1s ▶]  │
│ Ende  41:57.8  [◀ −1s][◀ −0.1s][▶ Vorhören][+0.1s ▶][+1s ▶]  │
│ Konfidenz: hoch ●   Alternativen: [B 1:02:10–1:05:40] [C …]  │
│                                              [Weiter →]      │
└───────────────────────────────────────────────────────────────┘
```

- Tastatur: Leertaste Play/Pause, `S`/`E` setzt Start/Ende an Abspielposition, Pfeiltasten verschieben aktiven Marker.
- Klare Fehlermeldungen in Alltagssprache („Der Server hat die Datei abgelehnt: Datei existiert bereits“).

---

## 8. Mehrere Apps unter einer Domain

### 8.1 Vite Multi-Page

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: '/audio-tools/',               // Repo-Name bei https://NAME.github.io/audio-tools/
  build: {
    rollupOptions: {
      input: {
        home:   resolve(__dirname, 'index.html'),
        predigt: resolve(__dirname, 'apps/predigt-schnitt/index.html'),
        // weitere Apps hier ergänzen
      },
    },
  },
  worker: { format: 'es' },
});
```

### 8.2 App-Registry für die Startseite

```json
[
  { "id": "predigt-schnitt", "title": "Predigt schneiden",
    "description": "Predigt automatisch erkennen, normalisieren, hochladen",
    "path": "apps/predigt-schnitt/", "icon": "scissors" }
]
```

Die Startseite rendert daraus Kacheln. Neue App = Ordner unter `apps/` + Eintrag in `apps.json` + Eintrag in `vite.config.ts`. Gemeinsame Teile (Decoder, Loudness, Upload, Einstellungen, UI-Kit) werden aus `packages/` importiert.

Mögliche Folge-Apps mit hohem Wiederverwendungsanteil:
- **Lesungen/Andachten schneiden** (gleiche Pipeline, andere Erkennungsparameter)
- **Intro/Outro anfügen** (Jingle + Ansage vor die Predigt)
- **Stapelverarbeitung** (mehrere Dateien mit Standardeinstellungen)
- **Podcast-Feed-Pflege** (RSS-Eintrag erzeugen und mit hochladen)

### 8.3 Deployment

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push: { branches: [main] }
permissions: { contents: read, pages: write, id-token: write }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run test --if-present
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: { name: github-pages }
    steps:
      - uses: actions/deploy-pages@v4
```

In den Repo-Einstellungen: *Settings → Pages → Source: GitHub Actions*.

---

## 9. Umsetzungsphasen

| Phase | Inhalt | Ergebnis / Abnahme |
|---|---|---|
| **0 – Gerüst** (½ Tag) | Repo, Vite-Multi-Page, Startseite, Deploy-Workflow, leere App | Seite unter `NAME.github.io/audio-tools/` erreichbar |
| **1 – Laden & Anzeigen** (1–2 Tage) | Datei laden, Streaming-Decode im Worker, Peaks, wavesurfer mit Regionen, manuelle Marker, Vorhören | 90-min-Datei lädt ohne Absturz; Marker setzbar |
| **2 – Export ohne Automatik** (1 Tag) | Bereich dekodieren, Fades, MP3-Encoder, ID3, Download | Ergebnis-MP3 in VLC/Handy korrekt, Länge stimmt |
| **3 – Lautheit** (1 Tag) | LUFS-Messung, Gain, Limiter, Hochpass | Abweichung zu ffmpeg-ebur128 < 0,5 LU; keine Übersteuerung |
| **4 – Upload** (½–1 Tag) | `upload.php` beim Hoster, Einstellungsseite, Upload mit Fortschritt | Datei erscheint im Zielordner; Fehlerfälle (401, 409, 413) verständlich angezeigt |
| **5 – Auto-Marker** (2–3 Tage) | Features, Segmentierung, Vorschlag + Alternativen, Kalibrierung mit Testaufnahmen | Median-Abweichung < 5 s auf Test-Set |
| **6 – Feinschliff** (1–2 Tage) | Tastaturbedienung, Presets, Einstellungs-Export, PWA, Hilfe-Texte | „Durchlauf in < 3 min“ mit echter Aufnahme |
| **7 – Optional** | Whisper-Verfeinerung (Kanzelgruß/-segen), Stapelbetrieb, RSS | – |

Bewusst wird der Export (Phase 2) vor der Automatik gebaut: So ist die App früh produktiv nutzbar, und die Automatik ist „nur“ eine Beschleunigung.

---

## 10. Tests

- **Unit-Tests (Vitest):** Segment-Zusammenführung, Marker-Einrasten, Gain-Berechnung, Dateinamen-Schema.
- **Referenztests Loudness:** synthetischer 1-kHz-Sinus bei −20 dBFS → bekannter LUFS-Wert; Vergleich mit ffmpeg an echten Aufnahmen.
- **Erkennungs-Benchmark:** Test-Set mit Soll-Markern (JSON), Skript gibt Abweichungstabelle aus.
- **Manuelle Checkliste:** Chrome, Firefox, Safari; Datei 5 min / 60 min / 120 min; Upload mit falschem Token; Upload doppelt; Netzabbruch.

---

## 11. Risiken & Gegenmaßnahmen

| Risiko | Gegenmaßnahme |
|---|---|
| Speicherüberlauf bei langen Aufnahmen | Streaming-Decoding, nur Features/Peaks im Speicher, Mehrfach-Decoding statt Zwischenspeicher |
| Fehlerkennung (z. B. lange Abkündigungen, Predigt mit eingespielter Musik) | Alternativvorschläge, Konfidenzanzeige, schnelle manuelle Korrektur, Zusammenführen von Lücken einstellbar |
| Hoster blockiert große Uploads / CORS | `.user.ini`, CORS-Header im Skript; Fallback Download |
| Token-Missbrauch | langer Zufallstoken, Origin-Prüfung, nur `.mp3`, kein Überschreiben, Größenlimit; Token rotierbar |
| Safari-Eigenheiten (Worker-Module, Audio-Autoplay) | früh auf Safari testen; Wiedergabe nur nach Nutzerklick |
| Urheberrecht bei Musikanteilen | Predigt-Schnitt schneidet Musik ohnehin weg; Hinweis in der Hilfe, keine Lieder mit hochladen |

---

## 12. Offene Fragen (vor Phase 4/5 klären)

1. Welcher Zielserver genau? Webspace mit PHP, Nextcloud/WebDAV oder nur FTP/SFTP?
2. Gibt es eine bestehende Gemeinde-Website/Podcast-Feed, der automatisch aktualisiert werden soll?
3. Typische Aufnahmequelle (Mischpult-Mitschnitt vs. Raummikrofon)? Beeinflusst Hochpass/Kompressor-Voreinstellung.
4. Soll Kanzelgruß/Kanzelsegen im Ergebnis enthalten sein?
5. Gewünschtes Namensschema und ID3-Felder.
6. Wird die App nur von einer Person oder von mehreren (verschiedene Geräte/Token) genutzt?
