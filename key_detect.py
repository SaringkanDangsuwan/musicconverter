#!/usr/bin/env python3
import json, sys, wave
import numpy as np

KEYS = ['C', 'C♯/D♭', 'D', 'D♯/E♭', 'E', 'F', 'F♯/G♭', 'G', 'G♯/A♭', 'A', 'A♯/B♭', 'B']
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

def detect(filename):
    with wave.open(filename, 'rb') as w:
        rate, channels, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(min(w.getnframes(), rate * 180))
    dtype = np.int16 if width == 2 else np.int32
    audio = np.frombuffer(raw, dtype=dtype).astype(np.float32)
    if channels > 1: audio = audio.reshape(-1, channels).mean(axis=1)
    if len(audio) < 4096: raise ValueError('audio too short')
    audio /= np.max(np.abs(audio)) + 1e-9
    size, hop = 8192, 4096
    chroma = np.zeros(12)
    freqs = np.fft.rfftfreq(size, 1 / rate)
    valid = (freqs >= 55) & (freqs <= 5000)
    midi = np.rint(69 + 12 * np.log2(np.maximum(freqs[valid], 1) / 440)).astype(int)
    pcs = midi % 12
    window = np.hanning(size)
    for start in range(0, len(audio) - size, hop):
        mag = np.abs(np.fft.rfft(audio[start:start+size] * window))[valid]
        np.add.at(chroma, pcs, np.sqrt(mag))
    chroma = (chroma - chroma.mean()) / (chroma.std() + 1e-9)
    scores = []
    for tonic in range(12):
        scores.append((np.corrcoef(chroma, np.roll(MAJOR, tonic))[0,1], tonic, 'major'))
        scores.append((np.corrcoef(chroma, np.roll(MINOR, tonic))[0,1], tonic, 'minor'))
    score, tonic, mode = max(scores)
    return {'key': KEYS[tonic], 'tonic': tonic, 'mode': mode, 'confidence': round(max(0, float(score)), 3)}

try: print(json.dumps(detect(sys.argv[1]), ensure_ascii=False))
except Exception as e: print(json.dumps({'key':'ไม่ทราบ', 'tonic':0, 'mode':'unknown', 'confidence':0, 'error':str(e)}, ensure_ascii=False))
