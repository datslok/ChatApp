// RNNoise from Kotlin: the `external` functions are written in C (src/main/cpp/denoiser.c), in our own
// native library, which loadLibrary loads the first time this is used.
package no.datslok.callservice

object Denoiser {
  init {
    System.loadLibrary("chatappaudio")
  }

  @JvmStatic external fun create(): Long
  @JvmStatic external fun destroy(state: Long)
  // Cleans 480 samples (10 ms at 48 kHz) in place.
  @JvmStatic external fun process(state: Long, frame: FloatArray): Float
}
