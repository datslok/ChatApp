// Noise suppression "On": RNNoise, a small neural network trained to tell speech from everything
// else (keyboards, fans, dogs, ...). Every 10 ms (480 samples at 48 000 a second) it cleans the
// sound and also says how sure it is that there's a voice in it: a score from 0 to 1. The noise
// gate (voice-gate.js) uses that score, so a keyboard click that RNNoise couldn't quite silence
// still doesn't open the microphone.
//
// RNNoise is C, compiled to WebAssembly: static/rnnoise-0.4.1/rnnoise_simd.wasm, from npm's
// @sapphi-red/web-noise-suppressor 0.4.1 (Shiguredo's @shiguredo/rnnoise-wasm 2022.2.0, Apache-2.0,
// of Xiph's RNNoise, BSD; see LICENSE). That package's own worklet throws the
// score away, so this one drives the .wasm file itself. The page (voice.js) fetches its bytes and
// hands them over; the browser runs this inside its audio engine, 128 samples at a time, like the gate.

const FRAME = 480;            // samples RNNoise works on at a time (10 ms)
const SCALE = 32767;          // RNNoise expects sound in 16-bit numbers (-32767..32767), not -1..1

class VoiceDenoiser extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.rnnoise = null;  // the WebAssembly functions, once loaded
    this.filled = 0;      // samples of the next frame collected so far
    // The cleaned sound on its way out, as a ring: written a frame at a time, read 128 samples at a
    // time, starting one frame (10 ms) behind, the time it takes to collect a frame.
    this.ring = new Float32Array(4 * FRAME);
    this.writeAt = FRAME;
    this.readAt = 0;
    this.load(options.processorOptions.wasmBinary);
  }

  async load(wasmBinary) {
    // The three things the compiled C asks of its surroundings (Emscripten's names): copying a big
    // piece of its memory, growing its memory, and stopping on a failed check. (The copy must give
    // nothing back: given the array, the browser would turn all 16 MB of it into a number, ~1 s a frame.)
    let memory;
    const env = {
      emscripten_memcpy_big: (to, from, count) => {
        new Uint8Array(memory.buffer).copyWithin(to, from, from + count);
      },
      emscripten_resize_heap: (size) => {
        try {
          memory.grow(Math.ceil((size - memory.buffer.byteLength) / 65536));  // in 64 KB pages
          return 1;
        } catch {
          return 0;
        }
      },
      __assert_fail: () => { throw new Error("RNNoise failed a check"); },
    };
    const { instance } = await WebAssembly.instantiate(wasmBinary, { env });
    const rnnoise = instance.exports;
    memory = rnnoise.memory;
    rnnoise.emscripten_stack_init();
    rnnoise.__wasm_call_ctors();  // the C library's own setting up
    this.state = rnnoise.rnnoise_create(0);  // 0: its built-in model
    // Room for one frame in and one out, inside its memory (4 bytes per number).
    this.inAt = rnnoise.malloc(FRAME * 4);
    this.outAt = rnnoise.malloc(FRAME * 4);
    this.memory = memory;
    this.rnnoise = rnnoise;
  }

  process(inputs, outputs) {
    const input = inputs[0][0];
    const output = outputs[0][0];
    if (!input) return true;  // nothing connected (noise suppression isn't "On"): no score either
    if (!this.rnnoise) {
      output.set(input);  // still loading (a moment at the start): let the sound through as it is
      return true;
    }
    // Views of its memory, made again if growing the memory replaced it (the old ones then read as empty).
    if (!this.frameIn || this.frameIn.length === 0) {
      this.frameIn = new Float32Array(this.memory.buffer, this.inAt, FRAME);
      this.frameOut = new Float32Array(this.memory.buffer, this.outAt, FRAME);
    }
    for (let i = 0; i < input.length; i++) {
      this.frameIn[this.filled++] = input[i] * SCALE;
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
    const score = this.rnnoise.rnnoise_process_frame(this.state, this.outAt, this.inAt);
    for (let i = 0; i < FRAME; i++) this.ring[this.writeAt + i] = this.frameOut[i] / SCALE;
    this.writeAt = (this.writeAt + FRAME) % this.ring.length;
    // For the gate: every worklet in one audio engine shares one global scope, so it reads these.
    // When it was said (currentFrame: the engine's sample count) tells the gate whether it's fresh.
    globalThis.voiceScore = score;
    globalThis.voiceScoreFrame = currentFrame;
  }
}

registerProcessor("voice-denoiser", VoiceDenoiser);
