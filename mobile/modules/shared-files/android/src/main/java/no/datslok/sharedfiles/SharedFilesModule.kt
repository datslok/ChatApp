// Files and text shared to the app from Android's share sheet (the gallery's Share, a link in Chrome, ...).
//
// Sharing is an Intent: a message that says "send this", with the type ("image/jpeg", "text/plain")
// and the data: each file as a content:// address the sending app lets us read, text as a string.
// Our main screen says it accepts those (plugins/share-intent.js puts that in the app's manifest).
// Android then hands the Intent to our activity in one of two ways:
//   - the app wasn't running: it starts with it, and JavaScript asks for it (getInitialShareAsync);
//   - the app was running: the activity is "singleTask" (only ever one), so instead of a second copy
//     the running one gets it (OnNewIntent), and we pass it on to JavaScript as an "onShare" event.
// Either way JavaScript gets {files: [{uri, name, size, type}], text} and copies the files it wants
// into the app's own storage (copyAsync) while we may still read them.
package no.datslok.sharedfiles

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.UUID

// A mark we put on an Intent once JavaScript has had it, so it isn't shared a second time (after a
// reload of the JavaScript, which asks for the start's Intent again).
private const val HANDLED = "no.datslok.sharedfiles.handled"

class SharedFilesModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SharedFiles")
    Events("onShare")

    // What the app was started with, if it was a share; else null.
    AsyncFunction("getInitialShareAsync") {
      appContext.currentActivity?.intent?.let { read(it) }
    }

    // A share while the app was already open. (Runs on the main thread; reading the names is quick.)
    OnNewIntent { intent ->
      read(intent)?.let { sendEvent("onShare", it) }
    }

    // Copy a shared file (its content:// address) into the app's cache, under its own name, in a
    // folder of its own (two files may have the same name): cache/shared/<random>/IMG_1234.jpg.
    // Returns {uri, size} of the copy. JavaScript empties cache/shared at every start.
    AsyncFunction("copyAsync") { uri: String, name: String ->
      val resolver = appContext.reactContext!!.contentResolver
      val folder = File(appContext.reactContext!!.cacheDir, "shared/${UUID.randomUUID()}")
      folder.mkdirs()
      val copy = File(folder, name)
      val input = resolver.openInputStream(Uri.parse(uri)) ?: throw CodedException("Couldn't read $name.")
      input.use { from -> copy.outputStream().use { to -> from.copyTo(to) } }
      mapOf("uri" to Uri.fromFile(copy).toString(), "size" to copy.length())
    }
  }

  // An Intent -> {files, text}, or null if it isn't a share (an ordinary start from the app's icon)
  // or was handled already.
  private fun read(intent: Intent): Map<String, Any?>? {
    if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return null
    if (intent.getBooleanExtra(HANDLED, false)) return null
    // Opened from the recent apps list after Android had closed the app: Android starts it again with
    // the Intent it first had, our mark gone (marks live in memory only). That share was dealt with then.
    if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return null
    intent.putExtra(HANDLED, true)

    val files = addresses(intent).map { describe(it, intent.type) }
    // The text that came along: a shared link, or a line some apps add to pictures.
    val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim()?.ifEmpty { null }
    if (files.isEmpty() && text == null) return null
    return mapOf("files" to files, "text" to text)
  }

  // The shared files' addresses: in EXTRA_STREAM, one (SEND) or a list (SEND_MULTIPLE). Android 13 got
  // a new way to read them, which says what kind of thing to expect (Uri); the old way still works
  // there, but is "deprecated", hence the @Suppress.
  @Suppress("DEPRECATION")
  private fun addresses(intent: Intent): List<Uri> {
    val modern = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
    if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
      return (if (modern) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
              else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)) ?: emptyList()
    }
    val one = if (modern) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
              else intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
    return listOfNotNull(one)
  }

  // A file's real name and size, asked from the app that shares it (OpenableColumns are the two
  // columns every content:// address must answer), and its type.
  private fun describe(uri: Uri, sharedType: String?): Map<String, Any?> {
    val resolver = appContext.reactContext!!.contentResolver
    var name: String? = null
    var size = -1L  // -1: unknown (it then gets measured when copied)
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { row ->
      if (row.moveToFirst()) {
        if (!row.isNull(0)) name = row.getString(0)
        if (!row.isNull(1)) size = row.getLong(1)
      }
    }
    // A "/" in a name would make a folder when it's copied.
    val cleanName = (name ?: uri.lastPathSegment ?: "file").replace('/', '_')
    // The file's own type, else the share's (which for several files may only be "image/*").
    val type = resolver.getType(uri) ?: sharedType?.takeUnless { it.endsWith("*") }
    return mapOf("uri" to uri.toString(), "name" to cleanName, "size" to size, "type" to type)
  }
}
