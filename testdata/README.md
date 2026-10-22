# Testdaten für die Erkennung

Dieser Ordner ist (bis auf diese Datei und das Beispiel) von Git ausgenommen – echte Aufnahmen
gehören nicht ins öffentliche Repository.

1. Aufnahmen (MP3) hier ablegen.
2. In `markers.json` je Aufnahme die von Hand bestimmten Soll-Marker eintragen
   (Sekunden oder `m:ss.s` / `h:mm:ss.s`), Vorlage: `markers.example.json`.
3. `npm run bench` ausführen. Ausgabe: Vorschlag, Soll, Abweichung Start/Ende, Konfidenz,
   Alternativen. Ziel laut Planung: Median < 5 s, nie > 30 s.

Optionen:

- `--csv` schreibt je Aufnahme `<datei>.windows.csv` mit allen Fenster-Merkmalen und der Soll-Zuordnung
  (`sermon`/`other`) – Grundlage zum Anpassen der Gewichte in `packages/audio-core/analysis.ts` (`TERMS`).
- `--render` exportiert die vorgeschlagene Predigt wie die App mit den Standard-Einstellungen (−19 LUFS,
  Kompression, max. +55 dB, Mono 96 kbps) nach `<datei>.predigt.mp3` und vergleicht die Lautheit mit
  `ffmpeg -af ebur128`. Mit `--denoise` (oder `--denoise=18` für eine andere Stärke in dB) zusätzlich mit
  Hall-/Rauschreduzierung (auf einem Kern, dauert einige Minuten).
- `DEBUG=1 npm run bench` listet zusätzlich alle erkannten Segmente.
