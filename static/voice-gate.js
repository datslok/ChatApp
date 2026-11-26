// The noise gate for voice: lets your microphone through while you're louder than the sensitivity
// line, and silences it when you're not. Or, with push to talk, while the key is held (the page
// tells it, voice.js: the audio engine can't see the keyboard). This is an AudioWorklet: the browser runs it inside its
// audio engine, on every block of 128 samples (2.7 ms at 48 000 samples a second), even while the
// window is minimised. The page loads it with audioContext.audioWorklet.addModule("/voice-gate.js").
//
// It also tells the page how loud the microphone is (for the level meter in Settings), about 30
// times a second, through its "port" (a message channel between the audio engine and the page).

const HOLD_SECONDS = 0.3;    // stay open this long after you go quiet, so word endings aren't cut off
const FADE_SECONDS = 0.005;  // open and close over a few milliseconds instead of instantly (no clicks)
const REPORTS_PER_SECOND = 30;

// The safety net: a "compressor" that only turns down, and only what's louder than LIMIT_DB (normal
// talking averages around -23 dB, its loud syllables reach about -15, so they're left alone). Above the line, 3 of every 4 dB more are taken away
// (LIMIT_RATIO 4). It turns down within a millisecond, so a word that starts booming (a leveller still
// turned up after a pause, see voice.js) is caught at once, and lets go slowly, over about 0.3 s, so it
// doesn't pump up and down inside a word. (The browser's own DynamicsCompressorNode turns everything
// else up afterwards to make up for it, background included, so it's done here instead.)
const LIMIT_DB = -14;
const LIMIT_RATIO = 4;
const LIMIT_ATTACK_SECONDS = 0.001;
const LIMIT_RELEASE_SECONDS = 0.3;

class VoiceGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.threshold = -100;  // dB: the sensitivity line (-100 = always open). The page sends the real one.
    this.ptt = false;       // push to talk: the key decides, not the line
    this.talking = false;   // ...and whether it's held right now
    this.holdLeft = 0;      // samples left before the gate may close
    this.gain = 0;          // how open it is right now: 0 (closed) to 1 (open)
    this.limit = 1;         // the safety net's volume right now: 1 = untouched, less = turned down
    this.loudest = -100;    // the loudest block since the last report, in dB
    this.sinceReport = 0;   // samples since the last report
    // The page sends {threshold} or {ptt, talking}: take whatever is in the message.
    this.port.onmessage = (event) => {
      const data = event.data;
      if ("threshold" in data) this.threshold = data.threshold;
      if ("ptt" in data) this.ptt = data.ptt;
      if ("talking" in data) this.talking = data.talking;
    };
  }

  // inputs[0] and outputs[0]: our one input and output, each a list of channels (arrays of samples).
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (input.length === 0) return true;  // nothing connected yet (the microphone isn't open)
    const samples = input[0];

    // How loud is this block? The "RMS" (root mean square) of the samples, in decibels: 0 dB is
    // the loudest possible, -100 dB is silence, quiet speech is around -40 dB.
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const level = Math.max(-100, 10 * Math.log10(sum / samples.length + 1e-10));

    // Loud enough (or, with push to talk, the key held): open, and keep it open for HOLD_SECONDS
    // (with push to talk: after letting go, so the last word isn't cut off). Otherwise, count down.
    if (this.ptt ? this.talking : level > this.threshold) {
      this.holdLeft = HOLD_SECONDS * sampleRate;  // sampleRate: given to every AudioWorklet
    } else {
      this.holdLeft = Math.max(0, this.holdLeft - samples.length);
    }
    const target = this.holdLeft > 0 ? 1 : 0;

    // The safety net: how far down this block should be. E.g. 8 dB over the line, ratio 4: 6 dB down
    // (it comes out 2 dB over). "10 ** (dB / 20)" turns decibels into a factor to multiply by.
    const over = Math.max(0, level - LIMIT_DB);
    const limitTarget = 10 ** (-over * (1 - 1 / LIMIT_RATIO) / 20);
    const limitStep = 1 - Math.exp(-1 / ((limitTarget < this.limit ? LIMIT_ATTACK_SECONDS : LIMIT_RELEASE_SECONDS) * sampleRate));

    // Copy the sound through, moving both volumes a little closer to their targets at every sample.
    const step = 1 - Math.exp(-1 / (FADE_SECONDS * sampleRate));
    for (let i = 0; i < samples.length; i++) {
      this.gain += (target - this.gain) * step;
      this.limit += (limitTarget - this.limit) * limitStep;
      const volume = this.gain * this.limit;
      for (let channel = 0; channel < output.length; channel++) {
        output[channel][i] = (input[channel] || samples)[i] * volume;
      }
    }

    // Now and then, tell the page the level and whether the gate is open.
    this.loudest = Math.max(this.loudest, level);
    this.sinceReport += samples.length;
    if (this.sinceReport >= sampleRate / REPORTS_PER_SECOND) {
      this.port.postMessage({ level: this.loudest, open: target === 1 });
      this.loudest = -100;
      this.sinceReport = 0;
    }
    return true;  // keep running
  }
}

registerProcessor("voice-gate", VoiceGate);
