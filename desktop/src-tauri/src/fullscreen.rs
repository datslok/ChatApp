// Fullscreen in a window of its own, so that the chat window stays exactly where it was: snapped
// included. (A video's ⛶, a call's or the Lounge's fullscreen; the page's side is in ui.js,
// goFullscreen.)
//
// When a page goes fullscreen, Tauri makes the window it's in fullscreen, and afterwards puts it
// back with Windows' SetWindowPlacement. For a snapped window that's where it was *before* it was
// snapped, and Windows no longer counts it as snapped. So the page first asks for a window of its
// own: an empty, borderless one exactly over the chat's page, and the page itself (the same one, so
// a video keeps playing and a call keeps going) moves into it ("reparent", from Tauri's "unstable"
// feature). Then the page goes fullscreen as always, and Tauri makes *that* window fullscreen
// (only because main.rs adds the page to the chat window with add_child: Tauri's fullscreen
// handler for a page made together with its window never learns that the page moved, and went on
// making the chat window fullscreen, with the page left behind in the small one). When
// it comes out, the page moves back and the extra window goes. The chat window is never touched.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::window::WindowBuilder;
use tauri::{Manager, WindowEvent};

const LABEL: &str = "fullscreen";

// One move at a time: the page and the window's own events can both ask at once.
static MOVING: Mutex<()> = Mutex::new(());
// True while the page is in the extra window.
static ACTIVE: AtomicBool = AtomicBool::new(false);
// True once the extra window has really been fullscreen, so that its resizes while it's being
// made don't count as coming out.
static WAS_FULLSCREEN: AtomicBool = AtomicBool::new(false);

// The page asks with on = true right before going fullscreen, and with false if that failed.
// (async: on a thread of its own. Moving the page waits for Tauri's main thread, so it mustn't
// run there.)
#[tauri::command(async)]
pub fn fullscreen_window(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    if on {
        enter(&app).map_err(|error| error.to_string())
    } else {
        leave(&app);
        Ok(())
    }
}

fn enter(app: &tauri::AppHandle) -> tauri::Result<()> {
    let _moving = MOVING.lock().unwrap();
    if ACTIVE.load(Ordering::SeqCst) {
        return Ok(());  // in it already
    }
    let (Some(main), Some(page)) = (app.get_window("main"), app.get_webview("main")) else {
        return Ok(());
    };
    // Exactly over the page (the inside of the chat window, without its title bar), so nothing
    // moves before the fullscreen itself. Hidden until the page is in it, and not on the taskbar:
    // the chat window's button is still there.
    let position = main.inner_position()?;
    let size = main.inner_size()?;
    let window = WindowBuilder::new(app, LABEL)
        .title("ChatApp")
        .decorations(false)
        .skip_taskbar(true)
        .visible(false)
        .build()?;
    window.set_decorations(false)?;  // (again: the first try still showed an old-style frame)
    window.set_position(position)?;
    window.set_size(size)?;
    WAS_FULLSCREEN.store(false, Ordering::SeqCst);

    let handle = app.clone();
    window.on_window_event(move |event| {
        // These run on Tauri's main thread, where moving the page can't: so on a thread of their own.
        let handle = handle.clone();
        match event {
            // In and out of fullscreen. Tauri marks the window as (not) fullscreen before resizing it.
            WindowEvent::Resized(_) => {
                std::thread::spawn(move || {
                    let Some(window) = handle.get_window(LABEL) else {
                        return;
                    };
                    if window.is_fullscreen().unwrap_or(false) {
                        WAS_FULLSCREEN.store(true, Ordering::SeqCst);
                    } else if WAS_FULLSCREEN.load(Ordering::SeqCst) {
                        leave(&handle);
                    }
                });
            }
            // Alt+F4: closing the window would close the page in it. Leave fullscreen instead (which
            // then moves the page back, above), or just move it back if it isn't fullscreen.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                std::thread::spawn(move || {
                    let fullscreen = handle.get_window(LABEL).is_some_and(|window| window.is_fullscreen().unwrap_or(false));
                    match handle.get_webview("main") {
                        Some(page) if fullscreen => {
                            let _ = page.eval("if (document.fullscreenElement) document.exitFullscreen()");
                        }
                        _ => leave(&handle),
                    }
                });
            }
            _ => {}
        }
    });

    page.reparent(&window)?;
    fill(&page, &window)?;
    ACTIVE.store(true, Ordering::SeqCst);
    window.show()?;
    window.set_focus()?;
    page.set_focus()?;
    Ok(())
}

fn leave(app: &tauri::AppHandle) {
    let _moving = MOVING.lock().unwrap();
    if !ACTIVE.load(Ordering::SeqCst) {
        return;  // back already
    }
    let Some(window) = app.get_window(LABEL) else {
        return;
    };
    // First the page back (destroying the window with the page in it would end the page too).
    if let (Some(main), Some(page)) = (app.get_window("main"), app.get_webview("main")) {
        if let Err(error) = page.reparent(&main) {
            eprintln!("Couldn't move the page back from fullscreen: {error}");
            return;  // keep the window, or the page would go with it
        }
        let _ = fill(&page, &main);
        ACTIVE.store(false, Ordering::SeqCst);
        let _ = window.destroy();  // (destroy, not close: close asks CloseRequested above again)
        let _ = main.set_focus();
        let _ = page.set_focus();
    }
}

// The page fills the whole inside of the window it's in. (After that, Tauri keeps it that way as
// the window changes size: the chat page is made with auto_resize, main.rs.)
fn fill(page: &tauri::Webview, window: &tauri::Window) -> tauri::Result<()> {
    page.set_position(tauri::PhysicalPosition::new(0, 0))?;
    page.set_size(window.inner_size()?)
}

// The chat window's taskbar button (or Alt+Tab) while the page is in the extra window: the chat
// window is empty then, so bring the extra one to the front instead.
pub fn watch_chat_window(app: &tauri::AppHandle) {
    let Some(main) = app.get_window("main") else {
        return;
    };
    let handle = app.clone();
    main.on_window_event(move |event| {
        if let WindowEvent::Focused(true) = event {
            if ACTIVE.load(Ordering::SeqCst) {
                let handle = handle.clone();
                std::thread::spawn(move || {
                    if let Some(window) = handle.get_window(LABEL) {
                        let _ = window.set_focus();
                    }
                });
            }
        }
    });
}
