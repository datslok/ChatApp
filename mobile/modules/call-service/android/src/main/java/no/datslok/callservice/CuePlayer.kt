// The short sounds of a call: "calling" (our own call ringing for the others), "join" and "leave"; and
// "ring", someone calling us while the app is open.
//
// Played here with Android's SoundPool (made for short sounds that must start at once) as "call
// signalling", the kind of sound meant for tones in a call, on the call's own volume. Played as media
// (expo-audio, which plays the ringtone), they waited seconds whenever Android was switching the audio
// into or out of call mode, which it does exactly when a call starts and ends: the join sound came
// 5-6 s after joining. The files are in res/raw (tools/make_call_sounds.py).
//
// The ring is a ringtone, on the phone's ring and notification volume (and silent on silent or vibrate,
// like any phone call), in a SoundPool of its own with that kind; it used to be media, on the music volume.
package no.datslok.callservice

import android.content.Context
import android.media.AudioAttributes
import android.media.SoundPool

object CuePlayer {
  private var pool: SoundPool? = null
  private val sounds = mutableMapOf<String, Int>()  // name -> SoundPool's number for it
  private var ringPool: SoundPool? = null
  private var ringSound = 0
  private var ringStream = 0  // the ring playing now (to stop it), or 0

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
    val ringtone = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()
    val ring = SoundPool.Builder().setMaxStreams(1).setAudioAttributes(ringtone).build()
    ringSound = ring.load(context, R.raw.chatapp_ring, 1)
    ringPool = ring
  }

  fun play(name: String) {
    if (name == "ring") {
      ringStream = ringPool?.play(ringSound, 1f, 1f, 1, 0, 1f) ?: 0  // (the ring volume decides)
      return
    }
    val id = sounds[name] ?: return
    pool?.play(id, 1f, 1f, 1, 0, 1f)  // both sides at full (the call volume decides), once, normal speed
  }

  // Answered, declined or over: the ring that's playing stops at once.
  fun stopRing() {
    if (ringStream != 0) ringPool?.stop(ringStream)
    ringStream = 0
  }
}
