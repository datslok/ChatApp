"""Makes the phone app's sounds (mobile/assets/sounds/*.wav) from the web page's.

The web page generates its sounds as it plays them, with Web Audio (notifications.js, playTone: a sine
wave that rises to its peak in 25 ms and then fades away exponentially). The phone app can't generate
sound like that, so this writes the same notes into WAV files once, which the app plays (expo-audio).
Run it again after changing a sound here (keep it the same as rooms.js and notifications.js).

Two also go to the push module's res/raw/ (mobile/modules/push), as the sounds of its notifications:
the ping for messages, and the ring for calls, which Android repeats until the call stops ringing.
And the ring and the sounds played during a call (calling, join, leave) go to the call-service module's res/raw/,
which plays them natively on Android's call signal channel (CuePlayer.kt): media sounds waited
seconds while Android switched the audio into or out of call mode.

    python tools/make_call_sounds.py
"""
import math
import struct
import wave
from pathlib import Path

RATE = 44100  # samples per second
FOLDER = Path(__file__).resolve().parent.parent / "mobile" / "assets" / "sounds"
# Android's resources: names may only have a-z, 0-9 and _ (the file name is the resource's name).
RAW = Path(__file__).resolve().parent.parent / "mobile" / "modules" / "push" / "android" / "src" / "main" / "res" / "raw"
CALL_RAW = Path(__file__).resolve().parent.parent / "mobile" / "modules" / "call-service" / "android" / "src" / "main" / "res" / "raw"


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


def write(name, samples, folder=FOLDER):
    folder.mkdir(parents=True, exist_ok=True)
    with wave.open(str(folder / name), "wb") as file:
        file.setnchannels(1)
        file.setsampwidth(2)  # 16-bit
        file.setframerate(RATE)
        file.writeframes(b"".join(struct.pack("<h", round(max(-1, min(1, s)) * 32767)) for s in samples))
    print(f"Wrote {folder / name}")


# rooms.js, playRingtone: two short "ring-ring"s (played every 2 s).
ring = []
for start, pitch in [(0, 660), (0.25, 880), (0.6, 660), (0.85, 880)]:
    tone(ring, pitch, start, 0.22, 0.12)
write("ring.wav", ring)
# The call notification's: silence after it up to 2 s, so Android's repeating keeps the same rhythm.
write("chatapp_ring.wav", ring + [0.0] * (2 * RATE - len(ring)), RAW)
# ...and the app's own, played while the app is open (CuePlayer.kt) as a ringtone: on the ring volume.
write("chatapp_ring.wav", ring, CALL_RAW)

# playCallingSound: A4 then C5 while our own call rings (every 1.2 s).
calling = []
tone(calling, 440, 0, 0.55, 0.08)
tone(calling, 523, 0.55, 0.55, 0.08)
write("chatapp_calling.wav", calling, CALL_RAW)

# playVoiceCue: "join" rises C5 -> G5, "leave" falls G5 -> C5.
for name, pitches in [("join.wav", [523, 784]), ("leave.wav", [784, 523])]:
    cue = []
    for index, pitch in enumerate(pitches):
        tone(cue, pitch, index * 0.12, 0.18, 0.1)
    write("chatapp_" + name, cue, CALL_RAW)

# notifications.js, playPing: two quick notes, like a soft chime, for a DM or a mention.
ping = []
tone(ping, 880, 0, 0.15, 0.15)    # A5
tone(ping, 1175, 0.08, 0.4, 0.15)  # then D6
write("ping.wav", ping)
write("chatapp_ping.wav", ping, RAW)
