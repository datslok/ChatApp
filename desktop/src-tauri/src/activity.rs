// Activity: what you're doing, shown under your name for everyone (Settings → App behaviour →
// Activity; the page's side is in settings.js, "Activity"). A web page can't see what else runs on
// the PC, so the app looks, every 5 seconds, at the windows that are open:
// - a game: a program run from a game library's folder (Steam's steamapps\common\<game>, Epic
//   Games, Xbox, ...). Its name is that folder's name, so nothing else about it is ever read.
// - Spotify: while a song plays its window's title is "Artist - Song" (paused: "Spotify Premium").
// - a program you added yourself in Settings, shown by the name you saw there.
// Other windows' titles are never sent anywhere: they can hold document names, websites, ...
//
// The calls into Windows come from Microsoft's `windows` package. They're "unsafe": Rust can't check
// code outside Rust, so we promise to pass them valid buffers and close what we open.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Manager;
use windows::core::{BOOL, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible};

// What the page chose: share at all, and your own programs as (file name in lowercase, shown name).
// Off until the page says (an older page never does: then nothing is shared).
struct Settings {
    share: bool,
    programs: Vec<(String, String)>,
}

static SETTINGS: Mutex<Settings> = Mutex::new(Settings { share: false, programs: Vec::new() });
static SEND_AGAIN: AtomicBool = AtomicBool::new(false);  // the page (re)loaded or changed something

// Settings.js tells us at every load and after every change.
#[tauri::command]
pub fn set_activity_settings(share: bool, programs: Vec<(String, String)>) {
    let mut settings = SETTINGS.lock().unwrap();
    settings.share = share;
    settings.programs = programs
        .into_iter()
        .take(50)
        .map(|(file, name)| (file.to_lowercase(), name.chars().take(100).collect()))
        .collect();
    SEND_AGAIN.store(true, Ordering::SeqCst);
}

// Windows' own helpers and this app: never offered.
const NOT_PROGRAMS: [&str; 6] = [
    "chatapp.exe", "explorer.exe", "applicationframehost.exe", "textinputhost.exe", "systemsettings.exe",
    "shellexperiencehost.exe",
];

// For "Add a program": every program with a window open right now, as (file name, its name), each
// once, sorted by name. Its name is the description in the program's file ("Visual Studio Code"),
// else its file name without ".exe".
#[tauri::command]
pub fn list_programs() -> Vec<(String, String)> {
    let mut programs: Vec<(String, String)> = Vec::new();
    for window in open_windows() {
        if programs.iter().any(|(file, _)| *file == window.file) || NOT_PROGRAMS.contains(&window.file.as_str()) {
            continue;
        }
        let name = description(&window.path).unwrap_or_else(|| window.file.trim_end_matches(".exe").to_string());
        programs.push((window.file, name));
    }
    programs.sort_by_key(|(_, name)| name.to_lowercase());
    programs
}

// Look every 5 seconds, and tell the page (activityFromApp in settings.js) when it changed.
pub fn watch(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last: Option<Value> = None;
        loop {
            let (share, programs) = {
                let settings = SETTINGS.lock().unwrap();
                (settings.share, settings.programs.clone())
            };
            let now = if share { detect(&open_windows(), &programs) } else { Value::Null };
            if SEND_AGAIN.swap(false, Ordering::SeqCst) || last.as_ref() != Some(&now) {
                if let Some(window) = app.get_webview_window("main") {
                    // serde_json writes it as JSON, which is always a valid JavaScript value.
                    let _ = window.eval(format!("activityFromApp({now})"));
                }
                last = Some(now);
            }
            // Wait 5 seconds, but answer a change in Settings within half a second.
            for _ in 0..10 {
                if SEND_AGAIN.load(Ordering::SeqCst) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    });
}

// A game first, then a song, then one of your programs.
fn detect(windows: &[Window], programs: &[(String, String)]) -> Value {
    for window in windows {
        if let Some(name) = game_name(&window.path) {
            return json!({"kind": "playing", "name": name});
        }
    }
    for window in windows {
        if window.file == "spotify.exe" {
            if let Some((artist, song)) = window.title.split_once(" - ") {
                return json!({"kind": "listening", "name": song, "details": artist});
            }
        }
    }
    for (file, name) in programs {
        if windows.iter().any(|window| window.file == *file) {
            return json!({"kind": "using", "name": name});
        }
    }
    Value::Null
}

// Where game libraries put their games: <library>\<the game's folder>\...
const GAME_FOLDERS: [&str; 8] = [
    "\\steamapps\\common\\",
    "\\epic games\\",
    "\\xboxgames\\",
    "\\riot games\\",
    "\\gog games\\",
    "\\gog galaxy\\games\\",
    "\\ubisoft game launcher\\games\\",
    "\\ea games\\",
];
// Folders in those that aren't games (the libraries' own programs).
const NOT_GAMES: [&str; 4] = ["launcher", "riot client", "steamworks shared", "directxredist"];

fn game_name(path: &str) -> Option<String> {
    // to_ascii_lowercase keeps every byte where it was, so a position in it is one in `path` too.
    let lower = path.to_ascii_lowercase();
    for marker in GAME_FOLDERS {
        if let Some(at) = lower.find(marker) {
            let rest = &path[at + marker.len()..];
            let (folder, _) = rest.split_once('\\')?;  // (a folder, not a file lying right there)
            if folder.is_empty() || NOT_GAMES.contains(&folder.to_ascii_lowercase().as_str()) {
                return None;
            }
            return Some(folder.to_string());
        }
    }
    None
}

struct Window {
    file: String,  // the program's file name, lowercase: "spotify.exe"
    path: String,  // its whole path
    title: String,
}

// Every visible window with a title, with the program it belongs to.
fn open_windows() -> Vec<Window> {
    let mut handles: Vec<HWND> = Vec::new();
    // EnumWindows calls `collect` once per window, handing it our list through the LPARAM.
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut handles as *mut Vec<HWND> as isize));
    }
    let mut windows = Vec::new();
    for handle in handles {
        unsafe {
            if !IsWindowVisible(handle).as_bool() {
                continue;
            }
            let mut title = [0u16; 512];
            let length = GetWindowTextW(handle, &mut title) as usize;
            if length == 0 {
                continue;
            }
            let mut process_id = 0u32;
            GetWindowThreadProcessId(handle, Some(&mut process_id));
            let Some(path) = program_path(process_id) else {
                continue;  // (a program we may not look at, like one running as administrator)
            };
            let file = path.rsplit('\\').next().unwrap_or("").to_lowercase();
            windows.push(Window { file, path, title: String::from_utf16_lossy(&title[..length]) });
        }
    }
    windows
}

unsafe extern "system" fn collect(handle: HWND, list: LPARAM) -> BOOL {
    let list = &mut *(list.0 as *mut Vec<HWND>);
    list.push(handle);
    BOOL(1)  // (1: go on with the next window)
}

// The program file of a running process, like C:\...\Spotify.exe.
fn program_path(process_id: u32) -> Option<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?;
        let mut buffer = [0u16; 1024];
        let mut length = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut length);
        let _ = CloseHandle(process);
        result.ok()?;
        Some(String::from_utf16_lossy(&buffer[..length as usize]))
    }
}

// The description in a program's file (Properties → Details → "File description").
fn description(path: &str) -> Option<String> {
    unsafe {
        let path = HSTRING::from(path);
        let size = GetFileVersionInfoSizeW(&path, None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(&path, None, size, data.as_mut_ptr().cast()).ok()?;
        // Its texts are kept per language: first ask which language it has...
        let mut pointer = std::ptr::null_mut();
        let mut length = 0u32;
        let query = HSTRING::from("\\VarFileInfo\\Translation");
        if !VerQueryValueW(data.as_ptr().cast(), PCWSTR(query.as_ptr()), &mut pointer, &mut length).as_bool() || length < 4 {
            return None;
        }
        let language = *(pointer as *const u16);
        let code_page = *(pointer as *const u16).add(1);
        // ...then for the description in that language.
        let query = HSTRING::from(format!("\\StringFileInfo\\{language:04x}{code_page:04x}\\FileDescription"));
        if !VerQueryValueW(data.as_ptr().cast(), PCWSTR(query.as_ptr()), &mut pointer, &mut length).as_bool() || length == 0 {
            return None;
        }
        let text = std::slice::from_raw_parts(pointer as *const u16, length as usize);
        let text = String::from_utf16_lossy(text).trim_end_matches('\0').trim().to_string();
        if text.is_empty() { None } else { Some(text) }
    }
}

