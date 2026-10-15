// What JavaScript uses for push notifications (modules/push/index.js):
//   - getTokenAsync(server): this phone's FCM token, for the server (/push/fcm); also keeps the
//     server's address for the notifications (pictures, Decline).
//   - Which notification opened the app: getInitialOpenAsync (it started the app) and "onOpen" events
//     (the app was running: our activity is "singleTask", so the running one gets the Intent), each
//     {channel, messageId, action}. The same way as modules/shared-files.
//   - Taking notifications away (a chat that's been seen, a call answered in the app), whether a call's
//     is ringing, and Android's settings for the app's notifications.
package no.datslok.push

import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessaging
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// A mark we put on an Intent once it's been dealt with, so it doesn't count twice (after a reload of
// the JavaScript).
private const val OPENED = "no.datslok.push.opened"

class PushModule : Module() {
  companion object {
    // Set while the JavaScript is there: PushService calls it with a new token.
    var onToken: ((String) -> Unit)? = null
  }

  private val context get() = appContext.reactContext ?: throw CodedException("The app isn't ready.")

  override fun definition() = ModuleDefinition {
    Name("Push")
    Events("onOpen", "onToken")

    OnCreate {
      onToken = { token -> sendEvent("onToken", mapOf("token" to token)) }
      appContext.reactContext?.let { Notifications.makeChannels(it) }
    }
    OnDestroy {
      onToken = null
    }

    AsyncFunction("getTokenAsync") { server: String, promise: Promise ->
      Notifications.saveServer(context, server)
      // Firebase asks Google for one the first time (that takes a moment), then keeps it. (Deprecated
      // since firebase-messaging 25.1, for a newer way built on installation IDs (register/onRegistered),
      // but still working, and Firebase's sending side, which our server uses, is still all tokens.)
      FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
        if (task.isSuccessful) promise.resolve(task.result)
        else promise.reject(CodedException("Couldn't get a token from Firebase: ${task.exception?.message}"))
      }
    }

    AsyncFunction("getInitialOpenAsync") {
      read(appContext.currentActivity?.intent)
    }

    OnNewIntent { intent ->
      read(intent)?.let { sendEvent("onOpen", it) }
    }

    Function("clearChat") { channel: String ->
      Notifications.cancelChat(context, channel)
    }
    Function("clearCall") { channel: String ->
      Notifications.cancelCall(context, channel)
    }
    Function("isCallShowing") { channel: String ->
      Notifications.callShowing(context, channel)
    }

    // Are notifications allowed at all (Android 13+'s question, or switched off in Android's settings)?
    Function("notificationsAllowed") {
      NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    // May a ringing call open our call screen over the lock screen? Android 14+ only lets calling and
    // alarm apps by default, and the user can change it ("Full screen notifications" in its settings).
    Function("canFillScreen") {
      if (Build.VERSION.SDK_INT < 34) return@Function true
      context.getSystemService(NotificationManager::class.java).canUseFullScreenIntent()
    }

    // Android's settings pages: the app's notifications, and full-screen notifications.
    Function("openNotificationSettings") {
      open(notificationSettings())
    }
    Function("openFillScreenSettings") {
      if (Build.VERSION.SDK_INT >= 34) {
        open(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}")))
      } else {
        open(notificationSettings())
      }
    }
  }

  private fun notificationSettings() =
    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)

  private fun open(intent: Intent) {
    context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }

  // An Intent -> {channel, messageId, action}, or null if no notification of ours opened the app (an
  // ordinary start from its icon), or it was dealt with already.
  private fun read(intent: Intent?): Map<String, Any?>? {
    if (intent == null) return null
    val action = intent.getStringExtra(Notifications.ACTION) ?: return null
    if (intent.getBooleanExtra(OPENED, false)) return null
    // Opened from the recent apps list after Android had closed the app: Android starts it again with
    // the Intent it first had, our mark gone. That notification was dealt with then.
    if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return null
    intent.putExtra(OPENED, true)
    val channel = intent.getStringExtra(Notifications.CHANNEL)
    // (Accept: the notification stays until the app has answered, which takes it away. Gone sooner, the
    // app would see a call ringing without its notification, and ring itself for a moment.)
    return mapOf(
      "channel" to channel,
      "messageId" to intent.getStringExtra(Notifications.MESSAGE)?.toIntOrNull(),
      "action" to action,
    )
  }
}
