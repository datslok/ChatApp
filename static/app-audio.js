// The shared program's sound, in the Windows app (video.js, "The shared program's sound"). The app
// captures one program's sound (app_audio.rs) and the page fetches it in pieces of ~20 ms; this
// AudioWorklet plays those pieces into a track that LiveKit sends as the share's sound. Like the
// noise gate (voice-gate.js), the browser runs it inside its audio engine, 128 samples at a time,
// even while the window is minimised (a game in front).
//
// Pieces don't arrive exactly on time, and the PC's sound card and the browser's audio engine
// tick at very slightly different speeds. So it keeps a little sound in hand: it starts once
// START_FRAMES are waiting, and if more than MAX_FRAMES pile up (it fell behind), it skips ahead to
// START_FRAMES again. If it runs dry it plays silence until it has START_FRAMES again.
//
// It also asks for the next piece itself, every ASK_EVERY blocks: the audio engine's clock keeps
// going in a minimised window, where the page's own timers would be slowed down to once a second.

const RATE = 48000;
const START_FRAMES = RATE * 0.06;  // 60 ms in hand (a "frame": one moment, left and right)
const MAX_FRAMES = RATE * 0.25;    // 250 ms: fallen behind
const ASK_EVERY = 8;               // blocks of 128 frames: ~21 ms

class AppAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.waiting = [];      // the pieces in hand: Float32Arrays of left, right, left, right, ...
    this.offset = 0;        // where in the first piece we are (in samples)
    this.frames = 0;        // frames in hand, over all pieces
    this.playing = false;   // false while gathering START_FRAMES
    this.blocks = 0;
    // The page sends each piece as an ArrayBuffer of 32-bit floats.
    this.port.onmessage = (event) => {
      const piece = new Float32Array(event.data);
      if (piece.length < 2) return;
      this.waiting.push(piece);
      this.frames += piece.length / 2;
      if (this.frames > MAX_FRAMES) this.skip(this.frames - START_FRAMES);
    };
  }

  // Throw away `count` frames from the front.
  skip(count) {
    while (count > 0 && this.waiting.length > 0) {
      const left = (this.waiting[0].length - this.offset) / 2;
      const take = Math.min(left, count);
      this.offset += take * 2;
      this.frames -= take;
      count -= take;
      if (this.offset >= this.waiting[0].length) {
        this.waiting.shift();
        this.offset = 0;
      }
    }
  }

  process(inputs, outputs) {
    if (++this.blocks % ASK_EVERY === 0) this.port.postMessage("more");
    const [left, right] = outputs[0];
    if (!this.playing && this.frames >= START_FRAMES) this.playing = true;
    if (!this.playing) return true;  // (outputs start out silent)
    for (let i = 0; i < left.length; i++) {
      if (this.waiting.length === 0) {
        this.playing = false;  // ran dry: the rest of this block stays silent
        break;
      }
      const piece = this.waiting[0];
      left[i] = piece[this.offset];
      right[i] = piece[this.offset + 1];
      this.offset += 2;
      this.frames -= 1;
      if (this.offset >= piece.length) {
        this.waiting.shift();
        this.offset = 0;
      }
    }
    return true;  // keep running
  }
}

registerProcessor("app-audio", AppAudio);
