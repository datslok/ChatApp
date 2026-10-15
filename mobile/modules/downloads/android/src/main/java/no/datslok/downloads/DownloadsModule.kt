// Saving a file in the phone's Download folder, the way a browser does when it downloads.
//
// Android keeps track of the shared folders (Download, Pictures, ...) in its media database,
// MediaStore. Since Android 10 an app doesn't write to those folders itself: it asks MediaStore for a
// new entry in its Downloads table (a name and a type), gets an address for it back (a content:// Uri),
// and writes the file's bytes there. That needs no permission for the app's own files.
// expo-media-library only knew the Pictures and DCIM folders, hence this module.
package no.datslok.downloads

import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class DownloadsModule : Module() {
  // What JavaScript sees: a module called "Downloads" with one function. An AsyncFunction runs on a
  // background thread and becomes a Promise in JavaScript; what it returns resolves it, and an
  // exception rejects it (with its message).
  override fun definition() = ModuleDefinition {
    Name("Downloads")

    // path: our own copy (a file:// address in the app's cache); name: the file's name, like "cat.jpg";
    // mimeType: like "image/jpeg". Returns {name, uri}: the name it got there ("cat (2).jpg" if there
    // were others) and its content:// address, for opening it in another app. (A Kotlin Map becomes a
    // JavaScript object.)
    AsyncFunction("saveAsync") { path: String, name: String, mimeType: String ->
      // MediaStore.Downloads came with Android 10 (API 29); the app runs from Android 7 (API 24).
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        throw CodedException("Saving to Download needs Android 10 or newer.")
      }
      // Uri.parse(...).path turns "file:///data/.../cat.jpg" into "/data/.../cat.jpg".
      val source = File(Uri.parse(path).path ?: throw CodedException("Not a file: $path"))
      save(source, name, mimeType)
    }
  }

  private fun save(source: File, name: String, mimeType: String): Map<String, String> {
    // A ContentResolver is how an app talks to databases like MediaStore. (`!!` is Kotlin for
    // "this isn't null, or throw": the React context is there while the app runs.)
    val resolver = appContext.reactContext!!.contentResolver

    // The new entry: its name, its type, and IS_PENDING = 1 ("still being written"), so no other app
    // (the gallery, say) sees a half-written file. `apply { }` runs the block on the new object, like
    // calling values.put(...) three times in Java.
    fun entry(displayName: String) = ContentValues().apply {
      put(MediaStore.Downloads.DISPLAY_NAME, displayName)
      put(MediaStore.Downloads.MIME_TYPE, mimeType)
      put(MediaStore.Downloads.IS_PENDING, 1)
    }

    // If the name is taken, MediaStore makes it unique itself: "cat (1).jpg", "cat (2).jpg", ... But
    // only up to 32 of them; then it throws, and we put the time in the name instead.
    val target: Uri = try {
      resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, entry(name))
    } catch (error: IllegalStateException) {
      resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, entry(withTime(name)))
    } ?: throw CodedException("Android wouldn't make a file in Download.")

    try {
      // Copy the bytes. `use { }` closes the stream afterwards, even after an error (Java's
      // try-with-resources).
      val output = resolver.openOutputStream(target) ?: throw CodedException("Couldn't write to Download.")
      output.use { out -> source.inputStream().use { input -> input.copyTo(out) } }
      // Done: IS_PENDING = 0, and the file appears for everyone.
      resolver.update(target, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
    } catch (error: Exception) {
      resolver.delete(target, null, null)  // no half files left behind
      throw error
    }

    // Ask MediaStore which name it gave the file (it may have added " (2)").
    val projection = arrayOf(MediaStore.Downloads.DISPLAY_NAME)
    val savedAs = resolver.query(target, projection, null, null, null)?.use { row ->
      if (row.moveToFirst()) row.getString(0) else null
    } ?: name
    return mapOf("name" to savedAs, "uri" to target.toString())
  }

  // "cat.jpg" -> "cat 2026-10-15 05.31.12.jpg"
  private fun withTime(name: String): String {
    val time = SimpleDateFormat("yyyy-MM-dd HH.mm.ss", Locale.ROOT).format(Date())
    val dot = name.lastIndexOf('.')
    return if (dot > 0) "${name.substring(0, dot)} $time${name.substring(dot)}" else "$name $time"
  }
}
