// In the finished app, don't open a console window next to it (development mode keeps it for errors).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::webview::NewWindowResponse;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
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
                .build()?;


            // Look for an update in the background, so the window opens right away.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = update(handle).await {
                    eprintln!("Update check failed: {error}");  // (offline, server down, ...): try next start
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ChatApp");
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
    // "quiet" in tauri.conf.json: no installer window). So: back to the chat, and try next start.
    window.close()?;
    if let Some(main) = &main {
        main.show()?;
    }
    result?;
    app.restart();
}
