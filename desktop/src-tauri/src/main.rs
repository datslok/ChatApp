// In the finished app, don't open a console window next to it (development mode keeps it for errors).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod activity;  // what you're doing (activity.rs)
mod app_audio;  // the shared program's sound (app_audio.rs)
mod share_bar;  // hides WebView2's "sharing your screen" bar (share_bar.rs)

use std::os::windows::process::CommandExt;  // raw_arg
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt as AutostartExt;  // app.autolaunch()
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_window_state::StateFlags;

fn main() {
    tauri::Builder::default()
        // Only one copy of the app at a time. Must be the first plugin: a second copy finds the first
        // one's lock (a named mutex), tells it, and quits before anything else starts. The first copy
        // then runs this and brings its window to the front.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| bring_to_front(app)))
        // Real Windows notifications: replaces the page's Notification, which WebView2 blocks here.
        // (Allowed for the chat page in capabilities/default.json.)
        .plugin(tauri_plugin_notification::init())
        // Updates: where to look and the public key to check them with are in tauri.conf.json.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Remembers the window's size, position and whether it's maximized: saved when the app
        // closes (in %APPDATA%\no.datslok.chat), put back when it starts. Not for the update and
        // loading windows, which should always appear centred at their own size. And not whether
        // it's visible: the chat window starts hidden behind the loading window (show_chat).
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["update", "loading"])
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        // Opens links in the default browser. Only our Rust code below uses it: the page isn't
        // allowed to (capabilities/default.json only gives it notifications). Without
        // open_js_links_on_click(false) the plugin adds a script to the page that catches left
        // clicks on links and asks for that from the page instead, which is refused: nothing happened.
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        // Starting with Windows (Settings → App behaviour): an entry in the user's list of programs
        // Windows starts at login (the registry's ...\CurrentVersion\Run, also in Task Manager →
        // Startup apps). The page only reaches it through get_autostart and set_autostart below.
        .plugin(tauri_plugin_autostart::Builder::new().build())
        // The commands the page may call (window.__TAURI_INTERNALS__.invoke("check_for_update")).
        // Made permissions in build.rs, allowed for the chat page in capabilities/default.json.
        .invoke_handler(tauri::generate_handler![check_for_update, set_zoom, get_autostart, set_autostart, set_push_to_talk, page_ready,
                                                 activity::set_activity_settings, activity::list_programs,
                                                 app_audio::start_app_audio, app_audio::read_app_audio, app_audio::stop_app_audio,
                                                 share_bar::hide_share_bar])
        .setup(|app| {
            // First, before the chat window opens WebView2's storage: repair it if it's damaged.
            repair_local_storage(app.handle());

            // The loading window first: it's in the app, so it shows at once (see show_chat).
            WebviewWindowBuilder::new(app, "loading", WebviewUrl::App("loading.html".into()))
                .title("ChatApp")
                .inner_size(300.0, 240.0)
                .resizable(false)
                .decorations(false)  // no title bar: a small card, like Discord's
                .center()
                .build()?;

            // The chat window, from its settings in tauri.conf.json ("create": false there, so that
            // we make it here, with a handler added): it shows https://chat.datslok.no. Hidden
            // until the page is ready (show_chat).
            let handle = app.handle().clone();
            WebviewWindowBuilder::from_config(app.handle(), &app.config().app.windows[0])?
                .visible(false)
                // A link with target="_blank" asks for a new window. Tauri says no to those unless
                // we decide, so: open web addresses in the default browser, and never a window here.
                .on_new_window(move |url, _features| {
                    if url.scheme() == "http" || url.scheme() == "https" {
                        if let Err(error) = handle.opener().open_url(url.as_str(), None::<&str>) {
                            eprintln!("Couldn't open {url}: {error}");
                        }
                    }
                    NewWindowResponse::Deny
                })
                // Downloads (a file from a message) go to Downloads as usual, which WebView2 does
                // without showing anything. So when one is done, open Explorer with the file selected.
                // (The opener plugin's reveal_item_in_dir quietly did nothing here, so: Explorer's own
                // "/select," option. raw_arg passes it exactly as written: Explorer is picky about quotes.)
                .on_download(|_webview, event| {
                    if let DownloadEvent::Finished { path: Some(path), success: true, .. } = event {
                        let select = format!("/select,\"{}\"", path.display());
                        if let Err(error) = Command::new("explorer.exe").raw_arg(select).spawn() {
                            eprintln!("Couldn't show {}: {error}", path.display());
                        }
                    }
                    true  // let every download through (for "Requested"; ignored for "Finished")
                })
                .build()?;


            // A click on one of our notifications ("tap"): bring the chat to the front and let the
            // page open the message. The page put its channel and message id in the notification's
            // "extra" (notifications.js); serde_json writes them as properly quoted JavaScript, so
            // they can only ever be values, never code. (Windows reports clicks on a notification
            // while it's on screen, not once it's in the Action Center.)
            let handle = app.handle().clone();
            app.notification().on_action(move |performed| {
                if performed.action_id() != "tap" {
                    return;
                }
                let Some(window) = handle.get_webview_window("main") else {
                    return;
                };
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                let Some(extra) = performed.notification().map(|notification| notification.extra()) else {
                    return;
                };
                if let (Some(channel), Some(message_id)) = (extra.get("channel"), extra.get("messageId")) {
                    let _ = window.eval(format!("openMessage({channel}, {message_id})"));
                }
            })?;

            // Push to talk: watch the chosen key, also while other programs are in front.
            watch_push_to_talk(app.handle().clone());

            // Activity: what you're playing or listening to (activity.rs).
            activity::watch(app.handle().clone());

            // Show the chat after 10 seconds even if the page never says it's ready (no internet,
            // the server down): then it shows its own "reconnecting" banner.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(10));
                show_chat(&handle);
            });

            // Starting with Windows is on by default (the first time only, see below).
            turn_on_autostart_once(app.handle());

            // Look for an update now, at the start (the page asks again later: check_for_update).
            update_in_background(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ChatApp");
}

// ----- The loading window
//
// The chat comes over the internet, so for a few seconds after starting there's nothing to draw:
// the window used to stay empty. Now the chat window starts hidden, the small loading window
// (ui/loading.html) shows instead, and the page says when it's ready to be seen: connected, and the
// first chat drawn (core.js, tellAppReady). Then the chat window appears and the loading one closes.

static CHAT_SHOWN: AtomicBool = AtomicBool::new(false);

fn show_chat(app: &tauri::AppHandle) {
    if CHAT_SHOWN.swap(true, Ordering::SeqCst) {
        return;  // only the first time (the page says "ready" again after every reload)
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    if let Some(loading) = app.get_webview_window("loading") {
        let _ = loading.close();
    }
}

// Someone opened the app while it was already running: show them the window they'd expect. The
// update window while updating, the loading window while the chat is still hidden behind it, else
// the chat window (even when minimized).
fn bring_to_front(app: &tauri::AppHandle) {
    let window = app.get_webview_window("update")
        .or_else(|| if CHAT_SHOWN.load(Ordering::SeqCst) { None } else { app.get_webview_window("loading") })
        .or_else(|| app.get_webview_window("main"));
    if let Some(window) = window {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn page_ready(app: tauri::AppHandle) {
    show_chat(&app);
}

// True while an update check (or the update itself) is running, so that a second one can't start
// next to it: say the page reconnects while the check from the start is still going. An AtomicBool
// is a true/false that several threads can read and change safely at the same time.
static UPDATING: AtomicBool = AtomicBool::new(false);

// The page calls this after it reconnects to the server (which restarts after a deploy or a new
// release) and after leaving a call, so that an app left open for days still gets new versions.
// It answers straight away; the check runs in the background.
#[tauri::command]
fn check_for_update(app: tauri::AppHandle) {
    update_in_background(app);
}

// Settings → Appearance's scale (appearance.js): WebView2's own zoom, like Ctrl + in Edge, so
// everything grows together (CSS zoom got sizes and mouse positions out of step). WebView2
// doesn't remember it, so the page asks again every time it loads. `window`: the one asking;
// `scale`: 1.2 for 120%, kept between 80% and 150% so a wrong value can't make the chat unusable.
#[tauri::command]
fn set_zoom(window: tauri::WebviewWindow, scale: f64) -> Result<(), String> {
    window.set_zoom(scale.clamp(0.8, 1.5)).map_err(|error| error.to_string())
}

// Settings → App behaviour: does Windows start the app at login? (Asked from Windows itself, so
// it's right even after it was switched off in Task Manager.)
#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|error| error.to_string())
}

// ... and switching it on or off.
#[tauri::command]
fn set_autostart(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    let autostart = app.autolaunch();
    let result = if on { autostart.enable() } else { autostart.disable() };
    result.map_err(|error| error.to_string())
}

// ----- Push to talk (Settings → Voice & audio; the page's side is in voice.js)
//
// A web page only hears keys while its window is in front, but push to talk matters most while
// you're in a game. So the app watches the key itself: a thread asks Windows "is this key down right
// now?" (GetAsyncKeyState) about 60 times a second, and tells the page when the answer changes.
// Only asking, never taking: Windows' own hotkeys (RegisterHotKey) would take the key away from
// every other program, so a push-to-talk V could no longer be typed anywhere.

// GetAsyncKeyState is part of Windows itself (user32.dll), so we can declare it and call it
// directly: no extra package. Its answer has the top bit set (negative) while the key is down.
#[link(name = "user32")]
extern "system" {
    fn GetAsyncKeyState(key: i32) -> i16;
}

// The key to watch, as Windows' number for it (a "virtual-key code"; 0 = none). Set by the page,
// read by the thread: an AtomicI32, like UPDATING below, is safe to share between threads.
static PUSH_TO_TALK_KEY: AtomicI32 = AtomicI32::new(0);

// The page tells us its key (voice.js, tellAppPushToTalkKey), and 0 when push to talk is off.
// Only real key numbers (1 to 254), so nothing odd ever reaches Windows.
#[tauri::command]
fn set_push_to_talk(key: i32) {
    PUSH_TO_TALK_KEY.store(if (1..=254).contains(&key) { key } else { 0 }, Ordering::SeqCst);
}

fn watch_push_to_talk(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut was_down = false;
        loop {
            let key = PUSH_TO_TALK_KEY.load(Ordering::SeqCst);
            // unsafe: Rust can't check what code outside Rust does. This call only reads a key's state.
            let down = key != 0 && unsafe { GetAsyncKeyState(key) } < 0;
            if down != was_down {
                was_down = down;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval(format!("pushToTalkFromApp({down})"));  // (true or false: never anything else)
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(if key == 0 { 250 } else { 15 }));
        }
    });
}

// On by default: the first time the app runs (0.1.17 or newer, so also after updating from an older
// version), switch starting with Windows on, and leave a marker file in %APPDATA%\no.datslok.chat
// so it never does that again. Someone who switches it off (in Settings or Task Manager) keeps it off.
// Not in development (npm run tauri dev): that would put the test build in the Run list.
fn turn_on_autostart_once(app: &tauri::AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let Ok(folder) = app.path().app_data_dir() else {
        return;
    };
    let marker = folder.join("autostart-default-done");
    if marker.exists() {
        return;  // done before: leave it as the person has it now
    }
    if let Err(error) = app.autolaunch().enable() {
        eprintln!("Couldn't turn on starting with Windows: {error}");
        return;  // no marker, so it tries again next time
    }
    let written = std::fs::create_dir_all(&folder).and_then(|_| std::fs::write(&marker, ""));
    if let Err(error) = written {
        eprintln!("Couldn't save {}: {error}", marker.display());
    }
}

// The page's localStorage (the audio settings, What's new's count, ...) is a small LevelDB database in
// WebView2's folder (%LOCALAPPDATA%\no.datslok.chat\EBWebView). If the app is killed while it's writing
// (an update's installer, a power cut), its file ends in half a record. LevelDB then throws away
// everything after that spot each time it opens, but keeps writing to the same file: from then on
// nothing new is ever kept (2026-10-14). Its LOG file says so ("Corruption"). Then move the database
// aside, before WebView2 opens it, and WebView2 makes a fresh one. (What was in it is lost either way.)
fn repair_local_storage(app: &tauri::AppHandle) {
    let Ok(folder) = app.path().app_local_data_dir() else {
        return;
    };
    let profile = folder.join("EBWebView").join("Default");
    let storage = profile.join("Local Storage");
    let Ok(log) = std::fs::read_to_string(storage.join("leveldb").join("LOG")) else {
        return;  // no database yet (a first start), or nothing to read
    };
    if !log.contains("Corruption") {
        return;
    }
    let aside = profile.join("Local Storage.broken");
    let _ = std::fs::remove_dir_all(&aside);  // (one set aside before: only the newest is kept)
    match std::fs::rename(&storage, &aside) {
        Ok(()) => eprintln!("localStorage was damaged: moved aside, WebView2 makes a new one."),
        Err(error) => eprintln!("localStorage is damaged, but couldn't move it aside: {error}"),
    }
}

// Look for an update in the background (so the window stays usable), unless one is already running.
fn update_in_background(app: tauri::AppHandle) {
    // swap sets it to true and gives back what it was: true means another check is busy.
    if UPDATING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(error) = update(app).await {
            eprintln!("Update check failed: {error}");  // (offline, server down, ...): try again later
        }
        UPDATING.store(false, Ordering::SeqCst);
    });
}

// If releases/latest.json names a newer version: swap the chat for our own small update window
// (ui/update.html), download the new version, check its signature, install it and start it.
async fn update(app: tauri::AppHandle) -> tauri_plugin_updater::Result<()> {
    let Some(update) = app.updater()?.check().await? else {
        return Ok(());  // already the newest version
    };

    // The update window. It runs before the page loads, so the page can show the version number.
    // (serde_json turns the version into a properly quoted JavaScript string.)
    let version = serde_json::to_string(&update.version)?;
    let window = WebviewWindowBuilder::new(&app, "update", WebviewUrl::App("update.html".into()))
        .title("Updating ChatApp")
        .inner_size(360.0, 260.0)
        .resizable(false)
        .maximizable(false)
        .closable(false)  // closing it wouldn't stop the update, only hide what's happening
        .center()
        .initialization_script(format!("window.NEW_VERSION = {version};"))
        .build()?;
    let main = app.get_webview_window("main");
    if let Some(main) = &main {
        main.hide()?;
    }
    // Found at the start: the update window replaces the loading window too, and the chat
    // mustn't pop up over it later.
    CHAT_SHOWN.store(true, Ordering::SeqCst);
    if let Some(loading) = app.get_webview_window("loading") {
        let _ = loading.close();
    }

    // Count the downloaded bytes, and move the progress bar each time the whole percentage changes
    // (a few hundred chunks, but only 100 updates for the page).
    let mut downloaded = 0;
    let mut shown = 0;
    let result = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                if let Some(total) = total {
                    let percent = downloaded * 100 / total;
                    if percent != shown {
                        shown = percent;
                        let _ = window.eval(format!("showProgress({percent})"));
                    }
                }
            },
            || {
                let _ = window.eval("showInstalling()");
            },
        )
        .await;
    let bytes = match result {
        Ok(bytes) => bytes,
        Err(error) => {
            // Couldn't download (offline, say): back to the chat, and try again later.
            window.close()?;
            if let Some(main) = &main {
                main.show()?;
            }
            return Err(error);
        }
    };

    // Before installing: close the chat window for good (it was only hidden) and give WebView2 a
    // moment to finish saving the page's localStorage. The installer ends this program, and a write
    // it cut off halfway damaged that storage (see repair_local_storage). Then install: on Windows a
    // successful install starts the installer and ends this program, and the installer starts the
    // new version (installMode "quiet" in tauri.conf.json: no installer window).
    if let Some(main) = main {
        main.destroy()?;
    }
    std::thread::sleep(std::time::Duration::from_secs(2));  // (this task's own thread: the window stays drawn)
    if let Err(error) = update.install(bytes) {
        eprintln!("Couldn't install the update: {error}");  // the chat window is gone: start again instead
    }
    app.restart();
}
