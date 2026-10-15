// What happens to our microphone's sound on its way into a call, after Android's echo cancelling and before
// it's sent: RNNoise (Settings → Voice & audio → Noise suppression → On) and the mic volume (0-200 %). The
// web page does the same in Web Audio (voice.js, openMic); a phone has no Web Audio, but LiveKit's Android
// library lets an app plug in a processor of its own ("capture post-processing", CallServiceModule.kt):
// WebRTC hands it every 10 ms of microphone sound, which it may change in place.
package no.datslok.callservice

import android.util.Log
import com.livekit.reactnative.audio.processing.AudioProcessorInterface
import java.nio.ByteBuffer
import java.nio.ByteOrder

object MicProcessor : AudioProcessorInterface {
  // Set from JavaScript (CallServiceModule), read on WebRTC's audio thread: @Volatile so it sees changes at once.
  @Volatile var gain = 1f
  @Volatile var denoise = false

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
  }
}
