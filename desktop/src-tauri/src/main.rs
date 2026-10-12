// In the finished app, don't open a console window next to it (development mode keeps it for errors).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::os::windows::process::CommandExt;  // raw_arg
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt as AutostartExt;  // app.autolaunch()
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

fn main() {
    tauri::Builder::default()
        // Real Windows notifications: replaces the page's Notification, which WebView2 blocks here.
        // (Allowed for the chat page in capabilities/default.json.)
        .plugin(tauri_plugin_notification::init())
        // Updates: where to look and the public key to check them with are in tauri.conf.json.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Remembers the window's size, position and whether it's maximized: saved when the app
        // closes (in %APPDATA%\no.datslok.chat), put back when it starts. Not for the update window,
        // which should always appear centred at its own size.
        .plugin(tauri_plugin_window_state::Builder::default().with_denylist(&["update"]).build())
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
        .invoke_handler(tauri::generate_handler![check_for_update, set_zoom, get_autostart, set_autostart])
        .setup(|app| {
            // The chat window, from its settings in tauri.conf.json ("create": false there, so that
            // we make it here, with a handler added): it shows https://chat.datslok.no.
            let handle = app.handle().clone();
            WebviewWindowBuilder::from_config(app.handle(), &app.config().app.windows[0])?
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

            // Look for an update now, at the start (the page asks again later: check_for_update).
            update_in_background(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ChatApp");
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

// ... and switching it on or off. Off by default: only the switch turns it on.
#[tauri::command]
fn set_autostart(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    let autostart = app.autolaunch();
    let result = if on { autostart.enable() } else { autostart.disable() };
    result.map_err(|error| error.to_string())
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

    // Count the downloaded bytes, and move the progress bar each time the whole percentage changes
    // (a few hundred chunks, but only 100 updates for the page).
    let mut downloaded = 0;
    let mut shown = 0;
    let result = update
        .download_and_install(
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

    // On Windows we only get here if something went wrong: a successful install starts the
    // installer and ends this program, and the installer starts the new version (installMode
    // "quiet" in tauri.conf.json: no installer window). So: back to the chat, and try again later.
    window.close()?;
    if let Some(main) = &main {
        main.show()?;
    }
    result?;
    app.restart();
}
