// Noise suppression "On": RNNoise, a small neural network trained to tell speech from everything
// else (keyboards, fans, dogs, ...). Every 10 ms (480 samples at 48 000 a second) it splits the sound
// into frequency bands and turns down each band by how little voice it hears in it.
//
// This is RNNoise 0.2 (2024; the phone app has the same), compiled to WebAssembly by Jitsi:
// static/jitsi-rnnoise-0.2.1/rnnoise-sync.js, from npm's @jitsi/rnnoise-wasm 0.2.1 (Apache-2.0, of
// Xiph's RNNoise, BSD; see the licences in that folder). The compiled filter is written inside that
// file as text, so it loads without asking the network: an AudioWorklet can't fetch anything.
// The browser runs this inside its audio engine, 128 samples at a time, like the gate (voice-gate.js).
//
// The cap: RNNoise's own output is never all there is. A tenth of the original sound (-20 dB) is
// mixed back in, so nothing is ever turned all the way down. Fully cut, RNNoise left short ringing
// "ticks" of keyboard clicks (like marbles), and a word it took for noise at first jumped from silence
// to full volume. With the floor, a click stays a soft click and a voice can only rise by 20 dB.
// (In silence the gate still closes, so the bit of background noise this lets through isn't sent.)

import createRNNWasmModuleSync from "/jitsi-rnnoise-0.2.1/rnnoise-sync.js";

const FRAME = 480;    // samples RNNoise works on at a time (10 ms)
const SCALE = 32767;  // RNNoise expects sound in 16-bit numbers (-32767..32767), not -1..1
const ORIGINAL = 0.1; // how much of the original is mixed back in (0.1 = -20 dB): the cap
// RNNoise 0.2 looks one frame ahead, so what comes out of it is two frames (20 ms) behind what went in
// (measured: an onset came out 960 samples later). The original we mix in is held back as long, so
// the two line up; otherwise they'd sound hollow, like a voice in a pipe.
const LATE_BY = 2;    // frames

// Loaded once, when voice.js adds this module (before the microphone is connected), since it takes
// a moment: any number of filters made later share it. null if it didn't work.
let rnnoise = null;
try {
  rnnoise = createRNNWasmModuleSync();
} catch (error) {
  console.warn("RNNoise didn't load:", error);
}

class VoiceDenoiser extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(FRAME);  // the next frame, being collected
    this.filled = 0;                       // samples of it collected so far
    // The frames that went in before it, the newest last: the original sound to mix in, LATE_BY back.
    this.earlier = Array.from({ length: LATE_BY }, () => new Float32Array(FRAME));
    // The cleaned sound on its way out, as a ring: written a frame at a time, read 128 samples at a
    // time, starting one frame (10 ms) behind, the time it takes to collect a frame.
    this.ring = new Float32Array(4 * FRAME);
    this.writeAt = FRAME;
    this.readAt = 0;
    if (rnnoise) {
      this.state = rnnoise._rnnoise_create(0);  // 0: its built-in model
      this.at = rnnoise._malloc(FRAME * 4);     // room for one frame inside its memory (4 bytes a number)
    }
  }

  process(inputs, outputs) {
    const input = inputs[0][0];
    const output = outputs[0][0];
    if (!input) return true;  // nothing connected (noise suppression isn't "On")
    if (!rnnoise) {
      output.set(input);  // RNNoise didn't load: let the sound through as it is
      return true;
    }
    for (let i = 0; i < input.length; i++) {
      this.frame[this.filled++] = input[i];
      if (this.filled === FRAME) {
        this.cleanFrame();
        this.filled = 0;
      }
    }
    for (let i = 0; i < output.length; i++) {
      output[i] = this.ring[this.readAt];
      this.readAt = (this.readAt + 1) % this.ring.length;
    }
    return true;  // keep running
  }

  cleanFrame() {
    // (The view of its memory is made each time: if the memory ever grew, an old view would read as empty.)
    const inside = new Float32Array(rnnoise.HEAPF32.buffer, this.at, FRAME);
    for (let i = 0; i < FRAME; i++) inside[i] = this.frame[i] * SCALE;
    rnnoise._rnnoise_process_frame(this.state, this.at, this.at);  // (in place: out = in)
    // What came out matches the frame LATE_BY back: the oldest kept.
    const original = this.earlier.shift();
    for (let i = 0; i < FRAME; i++) {
      this.ring[this.writeAt + i] = (inside[i] / SCALE) * (1 - ORIGINAL) + original[i] * ORIGINAL;
    }
    this.writeAt = (this.writeAt + FRAME) % this.ring.length;
    // This frame joins the kept ones; the oldest's array is reused for collecting the next.
    this.earlier.push(this.frame);
    this.frame = original;
  }
}

registerProcessor("voice-denoiser", VoiceDenoiser);
