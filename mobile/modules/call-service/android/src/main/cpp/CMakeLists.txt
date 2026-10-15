# How the NDK builds our native library, libchatappaudio.so: RNNoise's C code (rnnoise-0.2/, put there by
# tools/get_rnnoise.py) and our JNI bridge (denoiser.c). Gradle runs this for each processor type the app
# is built for (arm64 phones, older arm ones, and x86 for emulators). Kotlin loads it with
# System.loadLibrary("chatappaudio").
cmake_minimum_required(VERSION 3.22.1)
project(chatappaudio C)

# Every .c in rnnoise-0.2/src is part of the library (get_rnnoise.py copies only those).
file(GLOB RNNOISE_SOURCES rnnoise-0.2/src/*.c)

add_library(chatappaudio SHARED denoiser.c ${RNNOISE_SOURCES})
target_include_directories(chatappaudio PRIVATE rnnoise-0.2/include rnnoise-0.2/src)
target_compile_options(chatappaudio PRIVATE -O2)
# 16 KB memory pages: newer Android phones use them, and Google Play asks for libraries that work with them.
target_link_options(chatappaudio PRIVATE "-Wl,-z,max-page-size=16384")
target_link_libraries(chatappaudio m)  # (the maths library: RNNoise uses sqrt, exp, ...)
