"""Makes the phone app's call sounds (mobile/assets/sounds/*.wav) from the web page's.

The web page generates its sounds as it plays them, with Web Audio (notifications.js, playTone: a sine
wave that rises to its peak in 25 ms and then fades away exponentially). The phone app can't generate
sound like that, so this writes the same notes into WAV files once, which the app plays (expo-audio).
Run it again after changing a sound here (keep it the same as rooms.js).

    python tools/make_call_sounds.py
"""
import math
import struct
import wave
from pathlib import Path

RATE = 44100  # samples per second
FOLDER = Path(__file__).resolve().parent.parent / "mobile" / "assets" / "sounds"


def tone(samples, pitch, start, length, peak):
    """Adds playTone(pitch, start, length, peak) to samples (a list of floats, -1..1)."""
    first = int(start * RATE)
    count = int((length + 0.05) * RATE)  # (the oscillator stops 50 ms after it's silent)
    while len(samples) < first + count:
        samples.append(0.0)
    for i in range(count):
        t = i / RATE
        if t < 0.025:
            gain = peak * t / 0.025  # linearRampToValueAtTime(peak, +25 ms)
        elif t < length:
            # exponentialRampToValueAtTime(0.0001, +length): from peak to 0.0001 along an exponential curve.
            gain = peak * (0.0001 / peak) ** ((t - 0.025) / (length - 0.025))
        else:
            gain = 0.0001
        samples[first + i] += gain * math.sin(2 * math.pi * pitch * t)


def write(name, samples):
    FOLDER.mkdir(parents=True, exist_ok=True)
    with wave.open(str(FOLDER / name), "wb") as file:
        file.setnchannels(1)
        file.setsampwidth(2)  # 16-bit
        file.setframerate(RATE)
        file.writeframes(b"".join(struct.pack("<h", round(max(-1, min(1, s)) * 32767)) for s in samples))
    print(f"Wrote {FOLDER / name}")


# rooms.js, playRingtone: two short "ring-ring"s (played every 2 s).
ring = []
for start, pitch in [(0, 660), (0.25, 880), (0.6, 660), (0.85, 880)]:
    tone(ring, pitch, start, 0.22, 0.12)
write("ring.wav", ring)

# playCallingSound: A4 then C5 while our own call rings (every 1.2 s).
calling = []
tone(calling, 440, 0, 0.55, 0.08)
tone(calling, 523, 0.55, 0.55, 0.08)
write("calling.wav", calling)

# playVoiceCue: "join" rises C5 -> G5, "leave" falls G5 -> C5.
for name, pitches in [("join.wav", [523, 784]), ("leave.wav", [784, 523])]:
    cue = []
    for index, pitch in enumerate(pitches):
        tone(cue, pitch, index * 0.12, 0.18, 0.1)
    write(name, cue)
