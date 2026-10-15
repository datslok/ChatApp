// What JavaScript uses while it's in a call (modules/call-service/index.js):
//   - start(title, text, camera) / stop(): the foreground service (CallService.kt) and its notification;
//     start again to change the text, or when the camera goes on or off.
//   - The JavaScript timers keep running in the background while the service runs. React Native pauses
//     every setTimeout/setInterval when the app leaves the screen (JavaTimerManager, onHostPause)...
//     unless a "headless JS task" is running: its way of letting JavaScript work in the background. So
//     we start one when the call starts (its JavaScript, in index.js, never finishes by itself) and
//     finish it when the call ends. Without that, LiveKit's own timers (its pings, its negotiating when
//     someone joins) and the chat connection's reconnecting stop until the app is opened again.
//   - An "onHangUp" event when Hang up in the notification is tapped.
package no.datslok.callservice

import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat
import com.livekit.reactnative.LiveKitReactNative
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// The headless task's name: index.js registers its JavaScript under the same one.
private const val TASK = "ChatAppCall"

class CallServiceModule : Module() {
  private var taskId: Int? = null

  override fun definition() = ModuleDefinition {
    Name("CallService")
    Events("onHangUp")

    OnCreate {
      CallService.onHangUp = { sendEvent("onHangUp", mapOf<String, Any>()) }
      appContext.reactContext?.let { CuePlayer.load(it) }
      // Our microphone processing (MicProcessor.kt) goes into every call from now on. (LiveKit's setup,
      // which makes the controller, runs when the app starts, before any module.)
      try {
        LiveKitReactNative.audioProcessingController.capturePostProcessor = MicProcessor
      } catch (error: IllegalStateException) {
        Log.w("ChatAppMic", "LiveKit isn't set up: no mic volume or noise suppression", error)
      }
    }

    // Settings → Voice & audio: the mic volume (0-200 %) and whether RNNoise cleans the sound.
    Function("setMicVolume") { percent: Double ->
      MicProcessor.gain = (percent / 100).toFloat()
    }
    Function("setAiNoiseSuppression") { on: Boolean ->
      MicProcessor.denoise = on
    }
    // A call's short sound: "calling", "join" or "leave" (CuePlayer.kt).
    Function("playCue") { name: String ->
      CuePlayer.play(name)
    }
    OnDestroy {
      CallService.onHangUp = null
      stopService()
    }

    // (On the main thread: headless tasks may only be started from there.)
    AsyncFunction("start") { title: String, text: String, camera: Boolean ->
      val context = appContext.reactContext ?: throw CodedException("No app to start the call service in.")
      val intent = Intent(context, CallService::class.java)
        .putExtra("title", title)
        .putExtra("text", text)
        .putExtra("camera", camera)
      // startForegroundService: "this will be a foreground service", which then has a few seconds to
      // show its notification (CallService does at once). Android refuses it while the app is in the
      // background (an Exception, which reaches JavaScript as a rejected promise).
      ContextCompat.startForegroundService(context, intent)
      keepTimersRunning()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stop") {
      stopService()
    }.runOnQueue(Queues.MAIN)
  }

  private fun keepTimersRunning() {
    if (taskId != null) return
    val react = appContext.reactContext as? ReactContext ?: return
    // (timeout 0: no time limit; allowed in the foreground, where the app is now.)
    taskId = HeadlessJsTaskContext.getInstance(react)
      .startTask(HeadlessJsTaskConfig(TASK, Arguments.createMap(), 0, true))
  }

  private fun stopService() {
    val context = appContext.reactContext ?: return
    context.stopService(Intent(context, CallService::class.java))
    val id = taskId ?: return
    taskId = null
    (context as? ReactContext)?.let { HeadlessJsTaskContext.getInstance(it).finishTask(id) }
  }
}
