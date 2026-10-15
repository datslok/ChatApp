// The incoming call window: a small box in the middle of the screen with the caller's picture, "kari is
// calling…", Accept and Decline, and nothing else; the lock screen stays in sight around it. It looks
// like the app's own ringing popup (src/IncomingCall.js), in the default dark theme's colours.
//
// It's the only thing of ours that may show over the lock screen (the user's rule: the app itself
// never does, or anyone holding the locked phone could read the chats). A ringing call's notification
// opens it as its "full-screen intent": with the phone locked or its screen off, Android shows it
// straight away, like a phone call; on an unlocked phone in use, Android shows the notification with
// its buttons at the top instead. It's an "activity" of its own (a window, outside React Native), with
// a see-through background (its theme in the manifest), built here in code from a few plain views, in
// its own task, so it never brings the chat along.
//
// Decline: tells the server (DeclineReceiver) and closes. Accept: asks Android to unlock first (the
// lock screen's own PIN, pattern or fingerprint), and only then opens the app, which answers.
// The call ending elsewhere (answered on another device, the caller hung up, 30 s) closes it too.
package no.datslok.push

import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.StyleSpan
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.graphics.drawable.RoundedBitmapDrawableFactory
import java.lang.ref.WeakReference

class IncomingCallActivity : Activity() {
  companion object {
    const val TITLE = "no.datslok.push.title"
    const val BODY = "no.datslok.push.body"
    // The caller's picture, by chat, kept by Notifications.showCall (a picture is too big for an Intent).
    val pictures = mutableMapOf<String, Bitmap>()
    // The screen that's open, if any: a call that stops ringing closes it (Notifications.cancelCall).
    private var open: WeakReference<IncomingCallActivity>? = null

    fun closeFor(channel: String) {
      val screen = open?.get() ?: return
      if (screen.channel == channel) screen.runOnUiThread { screen.finish() }
    }
  }

  private var channel: String? = null
  private val timeout = Handler(Looper.getMainLooper())

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    channel = intent.getStringExtra(Notifications.CHANNEL)
    val call = channel ?: return finish()
    open = WeakReference(this)
    // Over the lock screen, screen on. (Android 8.1+; the manifest says the same, which older ones read.)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    }
    setFinishOnTouchOutside(false)  // (a tap beside it mustn't end the ringing by accident)
    setContentView(layout(call, intent.getStringExtra(TITLE) ?: "Someone", intent.getStringExtra(BODY) ?: ""))
    // The window: the screen's width, as tall as the box, in the middle; no darkening behind it.
    window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    window.setGravity(Gravity.CENTER)
    window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
    // (The server stops ringing after 30 s; the notification goes then, and so do we.)
    timeout.postDelayed({ finish() }, 30_000)
  }

  override fun onDestroy() {
    timeout.removeCallbacksAndMessages(null)
    if (open?.get() === this) open = null
    super.onDestroy()
  }

  // The box (IncomingCall.js's): the picture (80), "kari is calling…" (the name in bold), and a row
  // with Accept (green, the phone icon) and Decline (red); 12 dp rounding.
  private fun layout(call: String, title: String, body: String): View {
    val dp = resources.displayMetrics.density
    val box = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
      background = GradientDrawable().apply {
        setColor(Color.parseColor("#2b2d31"))  // bgPanel
        cornerRadius = 12 * dp
      }
      elevation = 12 * dp
      setPadding((24 * dp).toInt(), (20 * dp).toInt(), (24 * dp).toInt(), (20 * dp).toInt())
    }
    val size = (80 * dp).toInt()
    box.addView(ImageView(this).apply {
      layoutParams = LinearLayout.LayoutParams(size, size)
      val bitmap = pictures[call]
      if (bitmap != null) {
        setImageDrawable(RoundedBitmapDrawableFactory.create(resources, bitmap).apply { isCircular = true })
      } else {
        setImageResource(R.drawable.push_call_icon)  // (no picture: the phone, on a grey circle)
        setPadding(size / 4, size / 4, size / 4, size / 4)
        background = circle(Color.parseColor("#4e5058"))
      }
    })
    // DMs: "kari is calling…"; groups: the group's name, then "kari is calling" from the push's text. The
    // title in bold, like the popup's name.
    val rest = if (body.startsWith("📞 Calling you")) " is calling…" else "\n${body.removePrefix("📞 ")}…"
    val words = SpannableStringBuilder(title).apply {
      setSpan(StyleSpan(Typeface.BOLD), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      append(rest)
    }
    box.addView(text(words, 16f, Color.parseColor("#dbdee1"), top = 14))
    val buttons = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER
      setPadding(0, (14 * dp).toInt(), 0, 0)
    }
    buttons.addView(button("Accept", Color.parseColor("#248046"), showIcon = true) { accept(call) })
    buttons.addView(View(this), LinearLayout.LayoutParams((8 * dp).toInt(), 0))
    buttons.addView(button("Decline", Color.parseColor("#da373c"), showIcon = false) { decline(call) })
    box.addView(buttons)
    // Around the box: 16 dp on every side (room for its shadow).
    return LinearLayout(this).apply {
      setPadding((16 * dp).toInt(), (16 * dp).toInt(), (16 * dp).toInt(), (16 * dp).toInt())
      addView(box, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }
  }

  private fun text(words: CharSequence, size: Float, colour: Int, top: Int) = TextView(this).apply {
    text = words
    textSize = size
    setTextColor(colour)
    gravity = Gravity.CENTER
    setPadding(32, (top * resources.displayMetrics.density).toInt(), 32, 0)
  }

  // A button like the popup's: rounded (6 dp), padding 8 x 16 dp, white words, the phone icon before
  // Accept's.
  private fun button(label: String, colour: Int, showIcon: Boolean, onTap: () -> Unit): View {
    val dp = resources.displayMetrics.density
    return LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      background = GradientDrawable().apply {
        setColor(colour)
        cornerRadius = 6 * dp
      }
      setPadding((16 * dp).toInt(), (8 * dp).toInt(), (16 * dp).toInt(), (8 * dp).toInt())
      if (showIcon) {
        val icon = (18 * dp).toInt()
        addView(ImageView(this@IncomingCallActivity).apply {
          setImageResource(R.drawable.push_call_icon)
          layoutParams = LinearLayout.LayoutParams(icon, icon).apply { marginEnd = (6 * dp).toInt() }
        })
      }
      addView(TextView(this@IncomingCallActivity).apply {
        text = label
        textSize = 15.2f
        setTextColor(Color.WHITE)
      })
      contentDescription = label
      isClickable = true
      setOnClickListener { onTap() }
    }
  }

  private fun circle(colour: Int) = GradientDrawable().apply {
    shape = GradientDrawable.OVAL
    setColor(colour)
  }

  private fun decline(call: String) {
    sendBroadcast(Intent(this, DeclineReceiver::class.java).putExtra(Notifications.CHANNEL, call))
    finish()
  }

  // Unlock first (if locked), then open the app with "accept", which answers and joins the call.
  private fun accept(call: String) {
    val keyguard = getSystemService(KeyguardManager::class.java)
    val openApp = {
      startActivity(Notifications.appIntent(this, call, null, "accept"))
      finish()
    }
    // (Before Android 8 there's no asking: opening the app makes Android ask for the unlock by itself.)
    if (!keyguard.isKeyguardLocked || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      openApp()
      return
    }
    keyguard.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
      override fun onDismissSucceeded() = openApp()
      // (Cancelled or failed: the screen stays, still ringing, for another try or Decline.)
    })
  }
}
