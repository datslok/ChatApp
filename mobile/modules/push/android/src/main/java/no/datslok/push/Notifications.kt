// The notifications our pushes become (PushService.kt hands each push here): a chat's messages, a
// friend request, a ringing call.
//
// The server sends "data messages": only facts ({kind: "message", channel, sender, body, ...}), no
// ready-made notification. So it's our code that draws them, which lets us do what Android alone
// wouldn't: stack a chat's messages in one notification ("kari: hi", "kari: you there?"), with the
// sender's picture, and take a ringing call away again when it stops ringing.
//
// Notifications come in "channels" (Android 8+): each kind has its own switch, sound and importance in
// Android's settings for the app. Ours: "messages" (DMs, mentions, friend requests; the web page's ping
// as its sound) and "incoming_calls" (the ring, repeated until it stops).
//
// Each notification has a tag and a number, and posting one with the same pair replaces the old one:
// a chat's messages use (chat key, 1), a call (call:<chat key>, 2).
package no.datslok.push

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.IconCompat
import java.net.HttpURLConnection
import java.net.URL

object Notifications {
  const val MESSAGES = "messages"
  const val CALLS = "incoming_calls"
  const val MESSAGE_ID = 1
  const val CALL_ID = 2
  // The app's blue (the icon's square, app.json's backgroundColor): Android tints the cat and the app's
  // name in a notification's header with it, and the badge on a sender's picture.
  const val BLUE = 0xFF0086D7.toInt()
  // What a notification tells the app when it's tapped (extras on the Intent that opens it): the chat,
  // the message, and what to do: "open" (go to it), "ring" (a call's notification: show it ringing)
  // or "accept" (its Accept button).
  const val CHANNEL = "no.datslok.push.channel"
  const val MESSAGE = "no.datslok.push.message"
  const val ACTION = "no.datslok.push.action"
  private const val SETTINGS = "no.datslok.push"

  // The server's address (src/config.js's SERVER), kept on the phone: the pushes only carry paths
  // ("/avatars/x"), and Decline must reach it with the app closed. PushModule saves it.
  fun saveServer(context: Context, server: String) {
    context.getSharedPreferences(SETTINGS, Context.MODE_PRIVATE).edit().putString("server", server).apply()
  }

  fun server(context: Context): String? =
    context.getSharedPreferences(SETTINGS, Context.MODE_PRIVATE).getString("server", null)

  // Our two channels, made once (making one that exists changes nothing, but its sound can't change
  // after that: Android leaves those to the user).
  fun makeChannels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(MESSAGES) == null) {
      val channel = NotificationChannel(MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH)
      channel.description = "DMs, mentions and friend requests while the app is closed."
      channel.setSound(sound(context, "chatapp_ping"), attributes(AudioAttributes.USAGE_NOTIFICATION))
      manager.createNotificationChannel(channel)
    }
    if (manager.getNotificationChannel(CALLS) == null) {
      val channel = NotificationChannel(CALLS, "Incoming calls", NotificationManager.IMPORTANCE_HIGH)
      channel.description = "Someone calling you in a DM or group."
      channel.setSound(sound(context, "chatapp_ring"), attributes(AudioAttributes.USAGE_NOTIFICATION_RINGTONE))
      channel.enableVibration(true)
      channel.vibrationPattern = longArrayOf(0, 500, 1500)  // like the app's ringing: half a second every 2 s
      manager.createNotificationChannel(channel)
    }
  }

  // One of our sounds in res/raw (made by tools/make_call_sounds.py), as an address Android can play.
  private fun sound(context: Context, name: String): Uri =
    Uri.parse("${ContentResolver.SCHEME_ANDROID_RESOURCE}://${context.packageName}/raw/$name")

  private fun attributes(usage: Int): AudioAttributes =
    AudioAttributes.Builder().setUsage(usage).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()

  // A DM, a mention or a group message ("message"), or a friend request ("friend").
  fun showMessage(context: Context, data: Map<String, String>) {
    val channel = data["channel"] ?: return
    if (!allowed(context)) return
    makeChannels(context)
    val tap = openIntent(context, channel, data["message_id"], "open")
    val builder = NotificationCompat.Builder(context, MESSAGES)
      .setSmallIcon(R.drawable.push_cat_icon)  // the cat (tools/make_pwa_icons.py makes it)
      .setColor(BLUE)
      .setContentIntent(tap)
      .setAutoCancel(true)  // gone when tapped
      .setContentTitle(data["title"])
      .setContentText(data["body"])
    if (data["kind"] == "message") {
      // MessagingStyle: a conversation, each line with its sender. We take the chat's notification
      // that's showing (if any) and add this message under its others.
      val sender = Person.Builder()
        .setName(data["sender"] ?: "Someone")
        .setKey(data["sender_id"])  // (the same person in every message, even with the same name)
        .apply { picture(context, data["icon"])?.let { setIcon(IconCompat.createWithBitmap(it)) } }
        .build()
      val showing = showing(context, channel, MESSAGE_ID)
      val style = showing?.let { NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it) }
        ?: NotificationCompat.MessagingStyle(Person.Builder().setName("You").build())
      style.conversationTitle = data["chat"]       // "#general" or the group; none for a DM (the person is)
      style.isGroupConversation = data["chat"] != null
      style.addMessage(data["body"] ?: "", System.currentTimeMillis(), sender)
      builder.setStyle(style).setCategory(NotificationCompat.CATEGORY_MESSAGE)
      // The unread count on the app's icon. Android has no "put a number on my icon": launchers draw it
      // from the notifications showing, adding up their numbers (Samsung: with "Show number" on in its
      // settings, else a dot). So each chat's notification counts the messages stacked in it, and the
      // number goes when the notification does (tapped, or the chat opened in the app).
      builder.setNumber(style.messages.size)
    } else {
      picture(context, data["icon"])?.let { builder.setLargeIcon(it) }
      builder.setCategory(NotificationCompat.CATEGORY_SOCIAL)
      builder.setNumber(1)
    }
    post(context, channel, MESSAGE_ID, builder.build())
  }

  // Someone calling: Android's own call layout (CallStyle: the caller's name and picture, Decline and
  // Accept), ringing until it's answered. With the phone locked or its screen off, its "full-screen
  // intent" opens our call screen (IncomingCallActivity): only the caller and the two buttons. The app
  // itself never shows over the lock screen (the user's rule: that would show the chats to whoever holds
  // the phone), so Accept opens it after unlocking, as for any app; Decline needs no unlocking.
  fun showCall(context: Context, data: Map<String, String>) {
    val channel = data["channel"] ?: return
    if (!allowed(context)) return
    makeChannels(context)
    val picture = picture(context, data["avatar"])
    if (picture != null) IncomingCallActivity.pictures[channel] = picture
    val caller = Person.Builder()
      .setName(data["sender"] ?: "Someone")
      .setImportant(true)
      .apply { picture?.let { setIcon(IconCompat.createWithBitmap(it)) } }
      .build()
    val open = openIntent(context, channel, null, "ring")
    val accept = openIntent(context, channel, null, "accept")
    val decline = PendingIntent.getBroadcast(
      context, ("decline:$channel").hashCode(),
      Intent(context, DeclineReceiver::class.java).putExtra(CHANNEL, channel),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val screen = PendingIntent.getActivity(
      context, ("screen:$channel").hashCode(),
      Intent(context, IncomingCallActivity::class.java)
        .putExtra(CHANNEL, channel)
        .putExtra(IncomingCallActivity.TITLE, data["title"])
        .putExtra(IncomingCallActivity.BODY, data["body"])
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val notification = NotificationCompat.Builder(context, CALLS)
      .setSmallIcon(R.drawable.push_cat_icon)
      .setColor(BLUE)
      .setContentTitle(data["title"])
      .setContentText(data["body"])  // "📞 Calling you", or in a group "📞 kari is calling"
      .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, accept))
      .setContentIntent(open)
      .setFullScreenIntent(screen, true)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setOngoing(true)  // can't be swiped away: answer or decline
      .setTimeoutAfter(30_000)  // the server stops ringing after 30 s anyway (RING_SECONDS)
      .build()
    // INSISTENT: the sound repeats until the notification goes, like a ringing phone.
    notification.flags = notification.flags or Notification.FLAG_INSISTENT
    post(context, "call:$channel", CALL_ID, notification)
  }

  // A chat's notification goes when it's been seen (the chat opened in the app).
  fun cancelChat(context: Context, channel: String) {
    NotificationManagerCompat.from(context).cancel(channel, MESSAGE_ID)
  }

  // A call stopped ringing (answered somewhere, declined, over): its notification and call screen go.
  fun cancelCall(context: Context, channel: String) {
    NotificationManagerCompat.from(context).cancel("call:$channel", CALL_ID)
    IncomingCallActivity.closeFor(channel)
    IncomingCallActivity.pictures.remove(channel)
  }

  // Is this call's notification ringing? (Then the app doesn't ring as well.)
  fun callShowing(context: Context, channel: String): Boolean = showing(context, "call:$channel", CALL_ID) != null

  // May we show notifications? Android 13+ asks the user first (POST_NOTIFICATIONS); on any version
  // they can be switched off in Android's settings.
  private fun allowed(context: Context): Boolean {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) return false
    return NotificationManagerCompat.from(context).areNotificationsEnabled()
  }

  private fun post(context: Context, tag: String, id: Int, notification: Notification) {
    try {
      NotificationManagerCompat.from(context).notify(tag, id, notification)
    } catch (error: SecurityException) {
      // (The permission was taken away just now: nothing to show it with.)
    }
  }

  // The notification with this tag and number that's on the phone now, or null.
  private fun showing(context: Context, tag: String, id: Int): Notification? {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    return manager.activeNotifications.firstOrNull { it.tag == tag && it.id == id }?.notification
  }

  // Opening the app (its main screen) with the chat, the message and the action (for PushModule).
  fun appIntent(context: Context, channel: String, messageId: String?, action: String): Intent =
    context.packageManager.getLaunchIntentForPackage(context.packageName)!!
      .putExtra(CHANNEL, channel)
      .putExtra(MESSAGE, messageId)
      .putExtra(ACTION, action)

  // What a tap does: that, later. A PendingIntent is an Intent handed to Android to send later on our
  // behalf; IMMUTABLE: nobody else may change it. Each chat and action needs its own request code, or
  // Android would treat them as one and keep only the newest extras.
  private fun openIntent(context: Context, channel: String, messageId: String?, action: String): PendingIntent =
    PendingIntent.getActivity(
      context, ("$action:$channel").hashCode(), appIntent(context, channel, messageId, action),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

  // Someone's picture, from the server (only "/avatars/..." paths: everything else is the app's own
  // icon, and without a picture Android draws the name's first letter, like the chat). It needs the
  // login cookie, which React Native keeps in Android's CookieManager. Called on Firebase's background
  // thread, which may wait for the network a little (5 s at most; no picture then).
  private fun picture(context: Context, path: String?): Bitmap? {
    if (path == null || !path.startsWith("/avatars/")) return null
    val server = server(context) ?: return null
    return try {
      val connection = URL(server + path).openConnection() as HttpURLConnection
      connection.connectTimeout = 5000
      connection.readTimeout = 5000
      CookieManager.getInstance().getCookie(server)?.let { connection.setRequestProperty("Cookie", it) }
      connection.inputStream.use { BitmapFactory.decodeStream(it) }  // (a GIF gives its first picture)
    } catch (error: Exception) {
      null
    }
  }
}
