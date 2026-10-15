// Decline on a ringing call's notification. A "broadcast receiver": a small piece of the app Android
// runs for a moment, without opening it. It takes the notification away and tells the server
// (POST /calls/decline), with the login cookie, as the app itself may not be running.
package no.datslok.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.webkit.CookieManager
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class DeclineReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val channel = intent.getStringExtra(Notifications.CHANNEL) ?: return
    Notifications.cancelCall(context, channel)
    val server = Notifications.server(context) ?: return
    // goAsync: "I'm not done yet", so Android keeps us alive (10 s at most) while the request goes.
    // The network may not be used on this (the main) thread: in a thread of its own.
    val pending = goAsync()
    thread {
      try {
        val connection = URL("$server/calls/decline").openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.connectTimeout = 5000
        connection.readTimeout = 5000
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")
        CookieManager.getInstance().getCookie(server)?.let { connection.setRequestProperty("Cookie", it) }
        connection.outputStream.use { it.write(JSONObject().put("channel", channel).toString().toByteArray()) }
        connection.responseCode  // (sends it and waits for the answer; nothing to do with it)
        connection.disconnect()
      } catch (error: Exception) {
        // No connection: it simply keeps ringing for the caller until the 30 s are up.
      } finally {
        pending.finish()
      }
    }
  }
}
