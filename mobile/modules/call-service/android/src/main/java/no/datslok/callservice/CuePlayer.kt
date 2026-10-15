// The short sounds of a call: "calling" (our own call ringing for the others), "join" and "leave".
//
// Played here with Android's SoundPool (made for short sounds that must start at once) as "call
// signalling", the kind of sound meant for tones in a call, on the call's own volume. Played as media
// (expo-audio, which plays the ringtone), they waited seconds whenever Android was switching the audio
// into or out of call mode, which it does exactly when a call starts and ends: the join sound came
// 5-6 s after joining. The files are in res/raw (tools/make_call_sounds.py).
package no.datslok.callservice

import android.content.Context
import android.media.AudioAttributes
import android.media.SoundPool

object CuePlayer {
  private var pool: SoundPool? = null
  private val sounds = mutableMapOf<String, Int>()  // name -> SoundPool's number for it

  // Load the three once (SoundPool reads them into memory in the background).
  fun load(context: Context) {
    if (pool != null) return
    val attributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()
    val loaded = SoundPool.Builder().setMaxStreams(2).setAudioAttributes(attributes).build()
    sounds["calling"] = loaded.load(context, R.raw.chatapp_calling, 1)
    sounds["join"] = loaded.load(context, R.raw.chatapp_join, 1)
    sounds["leave"] = loaded.load(context, R.raw.chatapp_leave, 1)
    pool = loaded
  }

  fun play(name: String) {
    val id = sounds[name] ?: return
    pool?.play(id, 1f, 1f, 1, 0, 1f)  // both sides at full (the call volume decides), once, normal speed
  }
}
