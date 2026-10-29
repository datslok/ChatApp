// The noise gate for voice: lets your microphone through while you're louder than the sensitivity
// line (and, with noise suppression "On", sound like a voice), and silences it when you're not. Or,
// with push to talk, while the key is held (the page tells it, voice.js: the audio engine can't see
// the keyboard). This is an AudioWorklet: the browser runs it inside its
// audio engine, on every block of 128 samples (2.7 ms at 48 000 samples a second), even while the
// window is minimised. The page loads it with audioContext.audioWorklet.addModule("/voice-gate.js").
//
// It also tells the page how loud the microphone is (for the level meter in Settings), about 30
// times a second, through its "port" (a message channel between the audio engine and the page).

const HOLD_SECONDS = 0.3;    // stay open this long after you go quiet, so word endings aren't cut off
const FADE_SECONDS = 0.005;  // open and close over a few milliseconds instead of instantly (no clicks)
const REPORTS_PER_SECOND = 30;
// With noise suppression "On", RNNoise (voice-denoiser.js) also scores every 10 ms for how sure it
// is that it hears a voice, 0 to 1. Loud enough isn't enough then: it must sound like a voice too,
// so typing, clicks and bumps never open the gate. A score older than SCORE_FRESH_SECONDS means
// RNNoise isn't running ("Light" or "Off"): loudness alone decides, as before.
const VOICE_SCORE = 0.5;
const SCORE_FRESH_SECONDS = 0.05;

class VoiceGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.threshold = -100;  // dB: the sensitivity line (-100 = always open). The page sends the real one.
    this.ptt = false;       // push to talk: the key decides, not the line
    this.talking = false;   // ...and whether it's held right now
    this.holdLeft = 0;      // samples left before the gate may close
    this.gain = 0;          // how open it is right now: 0 (closed) to 1 (open)
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

    // Loud enough and a voice (or, with push to talk, the key held): open, and keep it open for
    // HOLD_SECONDS (with push to talk: after letting go, so the last word isn't cut off). Otherwise,
    // count down. All the way left (-100) means always on: no voice check either.
    if (this.ptt ? this.talking : level > this.threshold && (this.threshold <= -100 || this.soundsLikeVoice())) {
      this.holdLeft = HOLD_SECONDS * sampleRate;  // sampleRate: given to every AudioWorklet
    } else {
      this.holdLeft = Math.max(0, this.holdLeft - samples.length);
    }
    const target = this.holdLeft > 0 ? 1 : 0;

    // Copy the sound through, moving the gain a little closer to its target at every sample.
    const step = 1 - Math.exp(-1 / (FADE_SECONDS * sampleRate));
    for (let i = 0; i < samples.length; i++) {
      this.gain += (target - this.gain) * step;
      for (let channel = 0; channel < output.length; channel++) {
        output[channel][i] = (input[channel] || samples)[i] * this.gain;
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

  // RNNoise's latest score (voice-denoiser.js puts it in the global scope all worklets of one audio
  // engine share), or yes when there's no fresh one.
  soundsLikeVoice() {
    const age = currentFrame - (globalThis.voiceScoreFrame ?? -Infinity);
    return age > SCORE_FRESH_SECONDS * sampleRate || globalThis.voiceScore > VOICE_SCORE;
  }
}

registerProcessor("voice-gate", VoiceGate);
