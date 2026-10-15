// The bridge between Kotlin (Denoiser.kt) and RNNoise's C code: JNI, Java's way of calling C. Each function
// here is the native half of an `external fun` in Denoiser.kt, found by its name
// (Java_<package with _>_<class>_<function>).
//
// RNNoise works on frames of 480 samples (10 ms at 48 kHz), as floats in the 16-bit range (-32768..32767),
// and keeps what it learned about the noise so far in a "state", one per microphone.
#include <jni.h>
#include <stdint.h>
#include "rnnoise.h"

// A new state, with the model built into the library (NULL: its own). Returned to Kotlin as a number.
JNIEXPORT jlong JNICALL Java_no_datslok_callservice_Denoiser_create(JNIEnv *env, jclass cls) {
    return (jlong) (intptr_t) rnnoise_create(NULL);
}

JNIEXPORT void JNICALL Java_no_datslok_callservice_Denoiser_destroy(JNIEnv *env, jclass cls, jlong state) {
    rnnoise_destroy((DenoiseState *) (intptr_t) state);
}

// Cleans one frame (480 floats) in place. Returns how sure RNNoise is that it held a voice (0..1).
JNIEXPORT jfloat JNICALL Java_no_datslok_callservice_Denoiser_process(JNIEnv *env, jclass cls, jlong state,
                                                                      jfloatArray frame) {
    jfloat *samples = (*env)->GetFloatArrayElements(env, frame, NULL);
    float voice = rnnoise_process_frame((DenoiseState *) (intptr_t) state, samples, samples);
    (*env)->ReleaseFloatArrayElements(env, frame, samples, 0);  // (0: copy the cleaned samples back)
    return voice;
}
