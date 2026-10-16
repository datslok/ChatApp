// What happens to our microphone's sound on its way into a call, after Android's echo cancelling and before
// it's sent: RNNoise (Settings → Voice & audio → Noise suppression → On), the mic volume (0-200 %) and the noise
// gate (Settings → Voice & audio → Sensitivity: silent while quieter than its line, like voice-gate.js). The
// web page does the same in Web Audio (voice.js, openMic); a phone has no Web Audio, but LiveKit's Android
// library lets an app plug in a processor of its own ("capture post-processing", CallServiceModule.kt):
// WebRTC hands it every 10 ms of microphone sound, which it may change in place.
package no.datslok.callservice

import android.util.Log
import com.livekit.reactnative.audio.processing.AudioProcessorInterface
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.exp
import kotlin.math.log10

object MicProcessor : AudioProcessorInterface {
  // Set from JavaScript (CallServiceModule), read on WebRTC's audio thread: @Volatile so it sees changes at once.
  @Volatile var gain = 1f
  @Volatile var denoise = false
  // The gate's line in dB (-100: off, always open). And for JavaScript to read (CallServiceModule's
  // getMicLevel): the newest 10 ms's loudness in dB (Settings' meter), and whether the gate is open now
  // (our own speaking ring, which then matches what the others hear).
  @Volatile var gateDb = -100f
  @Volatile var level = -100f
  @Volatile var open = false

  private const val HOLD_SECONDS = 0.3f    // open this long after going quiet, so word endings aren't cut off
  private const val FADE_SECONDS = 0.005f  // open and close over a few milliseconds (no clicks)
  private var holdLeft = 0    // samples left before the gate may close
  private var gateGain = 0f   // how open it is right now: 0 (closed) to 1 (open)

  private const val FRAME = 480  // RNNoise's frame: 10 ms at 48 kHz
  private var sampleRate = 0
  private var state = 0L  // RNNoise's state (made on first use, on the audio thread)
  private val frame = FloatArray(FRAME)
  private var described = false

  override fun isEnabled() = true
  override fun getName() = "ChatApp microphone"

  override fun initializeAudioProcessing(sampleRateHz: Int, numChannels: Int) {
    sampleRate = sampleRateHz
    Log.i("ChatAppMic", "initialized: $sampleRateHz Hz, $numChannels channel(s)")
  }

  override fun resetAudioProcessing(newRate: Int) {
    sampleRate = newRate
  }

  // `buffer`: the samples as floats in the 16-bit range (-32768..32767), numFrames of them (one channel).
  override fun processAudio(numBands: Int, numFrames: Int, buffer: ByteBuffer) {
    val samples = buffer.order(ByteOrder.nativeOrder()).asFloatBuffer()
    val count = minOf(numFrames, samples.capacity())
    if (!described) {  // once, to see in Android's log what WebRTC hands us
      described = true
      Log.i("ChatAppMic", "first frame: $numFrames frames, $numBands band(s), ${samples.capacity()} floats, $sampleRate Hz")
    }
    // RNNoise only knows 48 kHz in frames of 480 (what WebRTC uses on phones); anything else passes as it is.
    if (denoise && sampleRate == 48000 && count == FRAME) {
      if (state == 0L) state = Denoiser.create()
      samples.get(frame, 0, FRAME)
      Denoiser.process(state, frame)
      samples.position(0)
      samples.put(frame, 0, FRAME)
    }
    val g = gain
    if (g != 1f) {
      for (i in 0 until count) samples.put(i, (samples.get(i) * g).coerceIn(-32768f, 32767f))
    }
    gate(samples, count)
  }

  // The noise gate, voice-gate.js's way: how loud these 10 ms are (the RMS of the samples scaled to -1..1, in
  // dB: 0 is the loudest possible, quiet speech about -40); louder than the line keeps it open HOLD_SECONDS
  // more; the sound fades towards open or closed a little at every sample.
  private fun gate(samples: java.nio.FloatBuffer, count: Int) {
    if (count == 0) return
    var sum = 0.0
    for (i in 0 until count) {
      val sample = samples.get(i) / 32768f
      sum += sample * sample
    }
    val db = maxOf(-100.0, 10 * log10(sum / count + 1e-10)).toFloat()
    level = db
    val rate = if (sampleRate > 0) sampleRate else 48000
    val line = gateDb
    holdLeft = if (line <= -100f || db > line) (HOLD_SECONDS * rate).toInt() else maxOf(0, holdLeft - count)
    val target = if (holdLeft > 0) 1f else 0f
    open = target == 1f
    if (target == 1f && gateGain >= 0.999f) {
      gateGain = 1f
      return  // open and settled: the sound passes as it is
    }
    val step = 1f - exp(-1.0 / (FADE_SECONDS * rate)).toFloat()
    for (i in 0 until count) {
      gateGain += (target - gateGain) * step
      samples.put(i, samples.get(i) * gateGain)
    }
  }
}
