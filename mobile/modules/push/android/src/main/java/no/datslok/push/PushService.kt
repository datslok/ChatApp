// Where our pushes arrive. Firebase's own code in the app keeps in touch with Google's servers (through
// Google Play services, one connection for every app on the phone) and, for each push, starts this
// service, even with the app closed, without starting React Native. We make the notification right
// here, in Kotlin (Notifications.kt), so it shows at once.
package no.datslok.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class PushService : FirebaseMessagingService() {
  // A push: its data is what server.py's send_push sent (every value as text). Runs on a background
  // thread, with about 10 seconds to finish.
  override fun onMessageReceived(message: RemoteMessage) {
    val data = message.data
    when (data["kind"]) {
      "message", "friend" -> Notifications.showMessage(this, data)
      "call" -> Notifications.showCall(this, data)
      "call_end" -> data["channel"]?.let { Notifications.cancelCall(this, it) }
    }
  }

  // Firebase gave this phone a new token (rare: after restoring the app's data, say). JavaScript sends
  // it to the server, if it's running; otherwise it does at the next connect anyway.
  override fun onNewToken(token: String) {
    PushModule.onToken?.invoke(token)
  }
}
