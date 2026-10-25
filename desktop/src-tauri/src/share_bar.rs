// The "ChatApp is sharing your screen · Stop sharing · Hide" bar (the user's wish: gone). WebView2,
// like Chrome, shows it while a page shares the screen or a window, and has no setting to turn it
// off. But it's a small window of its own, so the app hides it: the page asks (video.js, right after
// a share starts), and for a few seconds we look for it.
//
// How we know it's the bar, in any language: WebView2's programs (msedgewebview2.exe) are started by
// this app, and the chat itself is drawn inside our own window. So a visible top-level window that
// belongs to one of those programs, while a share is starting, is that bar. Stopping a share is the
// 🖥️ button's job, as before.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use windows::core::BOOL;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsWindowVisible, ShowWindow, SW_HIDE};

const LOOK_FOR: Duration = Duration::from_secs(5);  // the bar appears within a moment of the share starting
const EVERY: Duration = Duration::from_millis(100);

// Hide the bar. Returns how many windows were hidden (normally 1). On its own thread ("async"),
// as it waits between looks.
#[tauri::command(async)]
pub fn hide_share_bar() -> usize {
    let mut hidden = 0;
    let mut waited = Duration::ZERO;
    while waited < LOOK_FOR {
        for window in bar_windows(std::process::id()) {
            unsafe {
                let _ = ShowWindow(window, SW_HIDE);
            }
            hidden += 1;
        }
        if hidden > 0 {
            break;
        }
        std::thread::sleep(EVERY);
        waited += EVERY;
    }
    hidden
}

// The visible top-level windows of the programs this process started (and those started by them).
pub fn bar_windows(root: u32) -> Vec<HWND> {
    let ours = descendants(root);
    let mut handles: Vec<HWND> = Vec::new();
    // EnumWindows calls `collect` once per top-level window, handing it our list through the LPARAM.
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut handles as *mut Vec<HWND> as isize));
    }
    handles
        .into_iter()
        .filter(|&window| unsafe {
            let mut process_id = 0u32;
            GetWindowThreadProcessId(window, Some(&mut process_id));
            ours.contains(&process_id) && IsWindowVisible(window).as_bool()
        })
        .collect()
}

unsafe extern "system" fn collect(handle: HWND, list: LPARAM) -> BOOL {
    let list = &mut *(list.0 as *mut Vec<HWND>);
    list.push(handle);
    BOOL(1)  // (1: go on with the next window)
}

// Every process started by `root`, or by one of those, and so on (not `root` itself). From a
// "snapshot" of the running processes, which says each one's parent.
fn descendants(root: u32) -> HashSet<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return HashSet::new();
        };
        // (dwSize: Windows checks it to know which version of the struct we mean.)
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                children.entry(entry.th32ParentProcessID).or_default().push(entry.th32ProcessID);
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    let mut found = HashSet::new();
    let mut waiting = vec![root];
    while let Some(parent) = waiting.pop() {
        for &child in children.get(&parent).into_iter().flatten() {
            // (insert is false if seen already: Windows reuses numbers, so guard against loops)
            if child != root && found.insert(child) {
                waiting.push(child);
            }
        }
    }
    found
}
