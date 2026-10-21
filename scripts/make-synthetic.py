#!/usr/bin/env python3
"""Builds a synthetic church-service recording for smoke tests (no real recordings needed).

Organ music is additive synthesis, speech comes from espeak-ng (German voice), plus room
noise and a simple reverb. Writes testdata/synthetic-gottesdienst.mp3 and the true
sermon position to testdata/markers.json (merged with existing entries).

Usage: python3 scripts/make-synthetic.py [--sermon-min 11]
"""
import argparse, json, os, random, subprocess, tempfile, wave
import numpy as np

SR = 44100
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'testdata')
rng = np.random.default_rng(7)
random.seed(7)

SENTENCES = [
    "Gott hat uns nicht einen Geist der Furcht gegeben, sondern der Kraft und der Liebe.",
    "Das ist leichter gesagt als getan, denn jeder von uns kennt Tage, an denen die Sorgen überwiegen.",
    "Wir lesen heute einen Abschnitt aus dem Lukasevangelium, im achtzehnten Kapitel.",
    "Jesus erzählt ein Gleichnis von einer Witwe, die nicht aufhört, um ihr Recht zu bitten.",
    "Was bedeutet das für uns, hier und heute, in dieser Gemeinde?",
    "Vielleicht denken Sie an einen Menschen, der Ihnen in schwerer Zeit beigestanden hat.",
    "Beten heißt nicht, Gott zu überreden, sondern sich ihm anzuvertrauen.",
    "Manchmal bleibt die Antwort aus, und wir verstehen nicht, warum.",
    "Und doch: Die Witwe gibt nicht auf. Sie kommt wieder, Tag für Tag.",
    "Liebe Schwestern und Brüder, das ist eine Einladung zur Geduld.",
    "Geduld ist keine Schwäche. Sie ist eine Form von Hoffnung.",
    "In unserem Alltag sind wir es gewohnt, dass alles sofort verfügbar ist.",
    "Eine Nachricht, ein Klick, und schon ist die Antwort da.",
    "Mit Gott ist es anders. Er lässt sich Zeit, aber er vergisst uns nicht.",
    "Ich möchte Ihnen eine kleine Geschichte erzählen, die mir neulich begegnet ist.",
    "Eine ältere Frau aus unserer Nachbarschaft hat jeden Morgen für ihre Enkel gebetet.",
    "Jahrelang, ohne sichtbares Ergebnis. Und dann, eines Tages, kam ein Brief.",
    "Was ich damit sagen will: Unser Gebet ist nicht vergeblich.",
    "So lasst uns denn mit Vertrauen weitergehen, auch wenn der Weg nicht immer klar ist.",
]
LITURGY = ["Im Namen des Vaters und des Sohnes und des Heiligen Geistes.", "Unsere Hilfe steht im Namen des Herrn, der Himmel und Erde gemacht hat.",
           "Herzlich willkommen zum Gottesdienst an diesem Sonntag.", "Wir beten mit den Worten des Psalms."]
READING = ["Lesung aus dem Evangelium nach Lukas.", "Er sagte ihnen aber ein Gleichnis darüber, dass sie allezeit beten und nicht nachlassen sollten.",
           "Es war ein Richter in einer Stadt, der fürchtete sich nicht vor Gott und scheute sich vor keinem Menschen.",
           "Es war aber eine Witwe in derselben Stadt, die kam zu ihm und sprach: Schaffe mir Recht gegen meinen Widersacher."]
PRAYERS = ["Lasst uns beten.", "Barmherziger Gott, wir bitten dich für alle, die in Not sind.", "Wir bitten dich für die Kranken und die Einsamen.",
           "Herr, erbarme dich.", "Vater unser im Himmel, geheiligt werde dein Name.", "Der Herr segne dich und behüte dich. Amen."]


def espeak(text, speed=None):
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        path = f.name
    speed = speed or random.choice([135, 145, 150, 160])
    pitch = random.choice([35, 40, 45])
    subprocess.run(['espeak-ng', '-v', 'de', '-s', str(speed), '-p', str(pitch), '-g', '4', '-w', path, text], check=True)
    with wave.open(path) as w:
        sr, n = w.getframerate(), w.getnframes()
        x = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float64) / 32768
    os.unlink(path)
    # resample to SR (linear is fine for test material)
    t = np.arange(int(len(x) * SR / sr)) * sr / SR
    return np.interp(t, np.arange(len(x)), x)


def speech_block(sentences, minutes=None, pause=(0.4, 1.4)):
    parts, total = [], 0.0
    pool = list(sentences)
    while True:
        s = random.choice(pool) if minutes else pool.pop(0)
        y = espeak(s)
        y = y / (np.sqrt(np.mean(y ** 2)) + 1e-9) * 10 ** (-24 / 20) * random.uniform(0.8, 1.25)
        parts += [y, np.zeros(int(random.uniform(*pause) * SR))]
        total += len(y) / SR
        if minutes and total >= minutes * 60:
            break
        if not minutes and not pool:
            break
    return np.concatenate(parts)


def organ(seconds, hymn=False):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    y = np.zeros(n)
    chord_len = 2.0 if not hymn else 1.2
    roots = [0, 5, 7, 3, 8, 10, 0, 7]
    base = random.choice([110, 130.81, 146.83])
    for k in range(int(np.ceil(seconds / chord_len))):
        a, b = int(k * chord_len * SR), min(n, int((k + 1) * chord_len * SR))
        if a >= n:
            break
        tt = t[a:b]
        env = np.minimum(1, np.minimum((tt - tt[0]) / 0.08, (tt[-1] - tt + 1e-3) / 0.08))
        root = base * 2 ** (roots[k % len(roots)] / 12)
        seg = np.zeros(b - a)
        for interval in (0, 4, 7, 12):
            f = root * 2 ** (interval / 12)
            for h, amp in ((1, 1), (2, 0.5), (3, 0.3), (4, 0.2), (6, 0.1)):
                seg += amp * np.sin(2 * np.pi * f * h * tt + rng.uniform(0, 6))
        if hymn:  # melody voice on top, notes every 0.6 s
            for j in range(int(np.ceil(len(tt) / (0.6 * SR)))):
                c, d = int(j * 0.6 * SR), min(len(tt), int((j + 1) * 0.6 * SR))
                f = root * 4 * 2 ** (random.choice([0, 2, 4, 5, 7]) / 12)
                seg[c:d] += 1.2 * np.sin(2 * np.pi * f * tt[c:d]) * (1 + 0.05 * np.sin(2 * np.pi * 5.5 * tt[c:d]))
        y[a:b] = seg * env
    return y / (np.sqrt(np.mean(y ** 2)) + 1e-9) * 10 ** (-20 / 20)


def reverb(x, rt=0.9):
    n = int(rt * SR)
    ir = rng.standard_normal(n) * np.exp(-6.9 * np.arange(n) / n)
    ir[0] = 1.0
    ir /= np.sqrt(np.sum(ir ** 2))
    block = 1 << 18
    nfft = 1 << int(np.ceil(np.log2(block + n)))
    H = np.fft.rfft(ir, nfft)
    out = np.zeros(len(x) + n)
    for i in range(0, len(x), block):
        seg = x[i:i + block]
        y = np.fft.irfft(np.fft.rfft(seg, nfft) * H, nfft)[:len(seg) + n]
        out[i:i + len(y)] += y
    return 0.7 * x + 0.3 * out[:len(x)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sermon-min', type=float, default=11)
    args = ap.parse_args()
    gap = lambda s: np.zeros(int(s * SR))
    plan = [
        ('Orgel-Vorspiel', organ(60)), ('', gap(2)),
        ('Liturgie', speech_block(LITURGY)), ('', gap(2)),
        ('Lied', organ(120, hymn=True)), ('', gap(3)),
        ('Lesung', speech_block(READING)), ('', gap(2)),
        ('Lied', organ(90, hymn=True)), ('', gap(4)),
        ('PREDIGT', speech_block(SENTENCES, minutes=args.sermon_min)), ('', gap(3)),
        ('Lied', organ(120, hymn=True)), ('', gap(2)),
        ('Gebete', speech_block(PRAYERS)), ('', gap(2)),
        ('Orgel-Nachspiel', organ(60)),
    ]
    pos, sermon = 0, None
    for name, x in plan:
        if name == 'PREDIGT':
            sermon = (pos / SR, (pos + len(x)) / SR)
        pos += len(x)
    y = np.concatenate([x for _, x in plan])
    y = reverb(y)
    pink = np.cumsum(rng.standard_normal(len(y))) ; pink -= np.convolve(pink, np.ones(2000) / 2000, mode='same')
    y += pink / (np.sqrt(np.mean(pink ** 2)) + 1e-9) * 10 ** (-58 / 20)
    y = np.clip(y, -1, 1)
    os.makedirs(OUT_DIR, exist_ok=True)
    wav = os.path.join(OUT_DIR, 'synthetic.wav')
    with wave.open(wav, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((y * 32767).astype(np.int16).tobytes())
    mp3 = os.path.join(OUT_DIR, 'synthetic-gottesdienst.mp3')
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', wav, '-ac', '2', '-b:a', '128k', mp3], check=True)
    os.unlink(wav)
    markers_path = os.path.join(OUT_DIR, 'markers.json')
    markers = json.load(open(markers_path)) if os.path.exists(markers_path) else []
    markers = [m for m in markers if m['file'] != 'synthetic-gottesdienst.mp3']
    markers.append({'file': 'synthetic-gottesdienst.mp3', 'start': round(sermon[0], 2), 'end': round(sermon[1], 2)})
    json.dump(markers, open(markers_path, 'w'), indent=2)
    print(f'{mp3}: {len(y) / SR / 60:.1f} min, Predigt {sermon[0]:.1f}–{sermon[1]:.1f} s')


if __name__ == '__main__':
    main()
