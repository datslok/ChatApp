fn main() {
    // Our own commands (main.rs) become permissions, "allow-check-for-update" (and so on), which
    // capabilities/default.json then gives the chat page. Without this list every command would be
    // allowed to every page; with it, only what a capability names.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&[
                "check_for_update", "set_zoom", "get_autostart", "set_autostart", "set_push_to_talk",
            ])),
    )
    .expect("failed to run tauri-build");
}
