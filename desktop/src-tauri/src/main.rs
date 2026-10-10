// In the finished app, don't open a console window next to it (development mode keeps it for errors).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri_plugin_updater::UpdaterExt;

fn main() {
    // Open the window described in tauri.conf.json, which shows https://chat.datslok.no.
    tauri::Builder::default()
        // Real Windows notifications: replaces the page's Notification, which WebView2 blocks here.
        // (Allowed for the chat page in capabilities/default.json.)
        .plugin(tauri_plugin_notification::init())
        // Updates: where to look and the public key to check them with are in tauri.conf.json.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
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

// If releases/latest.json names a newer version: download it, check its signature, install it
// and start the new version.
async fn update(app: tauri::AppHandle) -> tauri_plugin_updater::Result<()> {
    if let Some(update) = app.updater()?.check().await? {
        update.download_and_install(|_, _| {}, || {}).await?;
        app.restart();
    }
    Ok(())
}
