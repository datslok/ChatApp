// The foreground service that keeps a call going with the phone locked or another app open.
//
// Android stops apps it doesn't see, to save battery: a little after the screen goes off, an ordinary
// app may no longer use the microphone, and may be frozen or closed. A *foreground service* is how an
// app says "I'm doing something you'd notice if it stopped" (music playing, a call): it must show a
// notification for as long as it runs, so you always know, and in exchange Android leaves it alone.
// Since Android 14 each one also says what it's for (its "types": microphone, camera, mediaPlayback),
// and may only use the microphone or camera in the background if it was started for that while the
// app was on screen, with the permission already given.
//
// The service itself does nothing but exist: the call (LiveKit, in JavaScript and react-native-webrtc)
// runs in the app as always. It holds the notification ("In a call · Lounge", with Hang up), and a
// "wake lock" so the processor doesn't fall asleep with the screen off.
package no.datslok.callservice

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

class CallService : Service() {
  companion object {
    // (Not "calls": that first one was low importance, which Samsung hides from the lock screen, and a
    // channel's importance can't be raised once it exists. makeChannel deletes it.)
    const val CHANNEL = "ongoing_calls"
    private const val OLD_CHANNEL = "calls"
    const val NOTIFICATION_ID = 7001
    const val HANG_UP = "no.datslok.callservice.HANG_UP"
    // Set by CallServiceModule while the JavaScript is there: Hang up in the notification calls it.
    var onHangUp: (() -> Unit)? = null
  }

  private var wakeLock: PowerManager.WakeLock? = null

  // (Nothing "binds" to this service: it's only ever started and stopped.)
  override fun onBind(intent: Intent?): IBinder? = null

  // Runs for each start: the first (from CallServiceModule.start), every update (the same, with a new
  // text or the camera on), and Hang up in the notification.
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == HANG_UP) {
      onHangUp?.invoke()  // JavaScript leaves the call, and then stops us
      return START_NOT_STICKY
    }
    val title = intent?.getStringExtra("title") ?: "In a call"
    val text = intent?.getStringExtra("text") ?: ""
    val camera = intent?.getBooleanExtra("camera", false) ?: false
    makeChannel()
    val notification = build(title, text)
    try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, types(camera))
    } catch (error: Exception) {
      // Refused (a permission taken away meanwhile, or Android said no): with only the sound playing,
      // or not at all. A thrown error here would close the whole app.
      try {
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, playbackType())
      } catch (again: Exception) {
        stopSelf()
        return START_NOT_STICKY
      }
    }
    holdWakeLock()
    // NOT_STICKY: if Android ever closes the app, don't start this again by itself (the call is gone).
    return START_NOT_STICKY
  }

  // Swiped away from the recent apps: the call ends with the app, so the notification goes too.
  override fun onTaskRemoved(rootIntent: Intent?) {
    stopSelf()
  }

  override fun onDestroy() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    super.onDestroy()
  }

  // What we're for: the sound always, the microphone and camera only if we have their permission
  // (asking for a type without it is refused). Android 10 knew only mediaPlayback.
  private fun types(camera: Boolean): Int {
    var types = playbackType()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      if (granted(Manifest.permission.RECORD_AUDIO)) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
      if (camera && granted(Manifest.permission.CAMERA)) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
    }
    return types
  }

  private fun playbackType(): Int =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0

  private fun granted(permission: String) =
    ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

  // Notifications come in "channels" (Android 8+), each with its own switch in the app's settings.
  // Default importance, so it shows on the lock screen too, but without a sound or buzz (it's there for
  // as long as the call lasts, and it's put up again whenever the call changes).
  private fun makeChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java)
    manager.deleteNotificationChannel(OLD_CHANNEL)
    if (manager.getNotificationChannel(CHANNEL) != null) return
    val channel = NotificationChannel(CHANNEL, "Ongoing calls", NotificationManager.IMPORTANCE_DEFAULT)
    channel.description = "Shown while you're in a call, so it keeps going with the phone locked."
    channel.setSound(null, null)
    channel.enableVibration(false)
    channel.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    manager.createNotificationChannel(channel)
  }

  // The notification: a tap opens the app, Hang up leaves the call. A PendingIntent is an Intent
  // handed to Android to send later on our behalf (IMMUTABLE: nobody else may change it).
  private fun build(title: String, text: String): Notification {
    val open = packageManager.getLaunchIntentForPackage(packageName)
    val openLater = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val hangUp = Intent(this, CallService::class.java).setAction(HANG_UP)
    val hangUpLater = PendingIntent.getService(this, 1, hangUp, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.call_notification_icon)  // the cat (tools/make_pwa_icons.py makes it)
      .setColor(0xFF0086D7.toInt())  // the app's blue, for the cat and the app's name
      .setContentTitle(title)
      .setContentText(text)
      .setContentIntent(openLater)
      .addAction(0, "Hang up", hangUpLater)
      .setOngoing(true)  // can't be swiped away
      .setOnlyAlertOnce(true)  // (no sound when it's put up again, for the camera or a new text)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)  // all of it on the lock screen: nothing private in it
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)  // shown at once
      .build()
  }

  // A "partial" wake lock keeps the processor running with the screen off (not the screen itself).
  private fun holdWakeLock() {
    if (wakeLock?.isHeld == true) return
    val power = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ChatApp:call").apply {
      setReferenceCounted(false)
      acquire()
    }
  }
}
