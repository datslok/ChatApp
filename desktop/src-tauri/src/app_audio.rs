// The shared program's sound (the page's side is in video.js, "The shared program's sound").
//
// A browser can share a window, but not its sound: only a tab's, or everything the PC plays. Windows
// itself can do better since Windows 10 version 2004: "process loopback" gives one program's sound
// (and its child processes', like a browser's audio process), nothing else. So when the page shares
// a window, it tells us which one (start_app_audio), a thread here captures that program's sound, and
// the page fetches it every ~20 ms (read_app_audio) and sends it as the share's sound.
//
// The sound comes as 48 000 samples a second (the page's rate), two channels (left, right, left,
// right, ...), each a 32-bit float between -1 and 1: 384 000 bytes a second, which only travel
// inside this PC.

use std::mem::ManuallyDrop;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use windows::core::{implement, Interface, Ref, HRESULT};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
    IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
};
use windows::Win32::Media::Multimedia::WAVE_FORMAT_IEEE_FLOAT;
use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, BLOB, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::Win32::System::Variant::VT_BLOB;
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

const RATE: u32 = 48_000;
const CHANNELS: u16 = 2;
// At most a second waits for the page (it fetches every ~20 ms): if it stops asking, the oldest goes.
const MAX_WAITING: usize = RATE as usize * CHANNELS as usize;
// The page closed or reloaded without saying stop: stop by ourselves after this long without a read.
const UNREAD_FOR: Duration = Duration::from_secs(5);

// The capture that's running (one at a time): what it caught since the page last asked, when the
// page last asked, and a flag that tells its thread to stop.
struct Capture {
    waiting: Vec<f32>,
    last_read: Instant,
    stop: Arc<AtomicBool>,
}

static CAPTURE: Mutex<Option<Capture>> = Mutex::new(None);

// Start capturing the sound of the program that owns `window` (the number in the shared track's
// name, "window:<number>:0"). Waits until Windows said yes or no, so the page knows. Runs on its own
// thread ("async"), not the window's: that would freeze while it waits.
#[tauri::command(async)]
pub fn start_app_audio(window: isize) -> Result<(), String> {
    stop_app_audio();
    let mut process_id = 0u32;
    unsafe { GetWindowThreadProcessId(HWND(window as *mut _), Some(&mut process_id)) };
    if process_id == 0 {
        return Err("that window isn't there".into());
    }
    // Sharing this app's own window: its "child processes" are WebView2's, which play the call
    // itself, so everyone would hear themselves back. No sound then.
    if process_id == std::process::id() {
        return Err("that's this app's own window".into());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let (started, answer) = mpsc::channel();
    let thread_stop = stop.clone();
    std::thread::spawn(move || capture(process_id, thread_stop, started));
    // The thread answers once Windows has said yes (or why not).
    answer.recv().map_err(|_| "the capture stopped".to_string())??;
    *CAPTURE.lock().unwrap() = Some(Capture { waiting: Vec::new(), last_read: Instant::now(), stop });
    Ok(())
}

// Everything caught since the last time, as raw bytes: the page gets them as an ArrayBuffer
// (a Float32Array of left, right, left, right, ...). Empty while nothing is being captured.
#[tauri::command(async)]
pub fn read_app_audio() -> tauri::ipc::Response {
    let mut capture = CAPTURE.lock().unwrap();
    let Some(capture) = capture.as_mut() else {
        return tauri::ipc::Response::new(Vec::new());
    };
    capture.last_read = Instant::now();
    let samples = std::mem::take(&mut capture.waiting);
    let bytes: Vec<u8> = samples.iter().flat_map(|sample| sample.to_le_bytes()).collect();
    tauri::ipc::Response::new(bytes)
}

#[tauri::command]
pub fn stop_app_audio() {
    if let Some(capture) = CAPTURE.lock().unwrap().take() {
        capture.stop.store(true, Ordering::SeqCst);  // the thread sees it within 100 ms and ends
    }
}

// The capture thread: ask Windows for the program's sound, then, each time Windows signals that
// more has come in (about every 10 ms), move it into CAPTURE.waiting, until told to stop (or the
// page stopped asking).
fn capture(process_id: u32, stop: Arc<AtomicBool>, started: mpsc::Sender<Result<(), String>>) {
    unsafe {
        // COM: the way Windows' audio parts are reached. Each thread that uses it says so first.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        // The "event" Windows sets when sound is ready: a flag one thread can wait on and another set.
        match CreateEventW(None, false, false, None) {
            Ok(ready) => {
                match open(process_id, ready) {
                    Ok((client, reader)) => {
                        let _ = started.send(Ok(()));
                        if let Err(error) = read_loop(&reader, ready, &stop) {
                            eprintln!("The shared program's sound stopped: {error}");
                        }
                        let _ = client.Stop();
                    }
                    Err(error) => {
                        let _ = started.send(Err(format!("Windows said no: {error}")));
                    }
                }
                let _ = CloseHandle(ready);
            }
            Err(error) => {
                let _ = started.send(Err(format!("no event: {error}")));
            }
        }
        CoUninitialize();
    }
}

// Ask Windows for an audio client that records one process (and its children), started, and that
// sets `ready` whenever there's sound to read.
unsafe fn open(process_id: u32, ready: HANDLE) -> windows::core::Result<(IAudioClient, IAudioCaptureClient)> {
    // What to record: this process and everything it started.
    let params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: process_id,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    // ...handed over as a PROPVARIANT, Windows' "any kind of value" box, holding a pointer to those
    // bytes (a "blob"). ManuallyDrop: when a PROPVARIANT goes away, windows-rs clears it with
    // PropVariantClear, which frees a blob's bytes as if Windows had allocated them. Ours are
    // `params`, right here, so that "freeing" corrupted the app's memory and Windows ended it (0.1.23).
    let boxed = ManuallyDrop::new(PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_BLOB,
                Anonymous: PROPVARIANT_0_0_0 {
                    blob: BLOB {
                        cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                        pBlobData: &params as *const _ as *mut u8,
                    },
                },
                ..Default::default()
            }),
        },
    });

    // Windows answers this one later, by calling our Done handler (below) from one of its threads.
    let (done, answer) = mpsc::channel();
    let handler: IActivateAudioInterfaceCompletionHandler = Done(Mutex::new(Some(done))).into();
    let operation = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        &IAudioClient::IID,
        Some(&*boxed as *const PROPVARIANT),
        &handler,
    )?;
    let _ = answer.recv_timeout(Duration::from_secs(5));
    let mut result = HRESULT(0);
    let mut activated = None;
    operation.GetActivateResult(&mut result, &mut activated)?;
    result.ok()?;
    let client: IAudioClient = activated.ok_or_else(windows::core::Error::empty)?.cast()?;

    // The format we want. This kind of client has no format of its own to suggest, and AUTOCONVERTPCM
    // makes Windows convert the program's sound to it, whatever the program plays.
    let block = CHANNELS * 4;  // the bytes of one moment: two 4-byte floats
    let format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_IEEE_FLOAT as u16,
        nChannels: CHANNELS,
        nSamplesPerSec: RATE,
        nAvgBytesPerSec: RATE * block as u32,
        nBlockAlign: block,
        wBitsPerSample: 32,
        cbSize: 0,
    };
    // A 200 ms buffer on Windows' side (in units of 100 ns), plenty for reading it every 10 ms.
    // EVENTCALLBACK: Windows sets `ready` when there's sound (Microsoft's own sample does it this way).
    client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
        2_000_000,
        0,
        &format,
        None,
    )?;
    client.SetEventHandle(ready)?;
    let reader: IAudioCaptureClient = client.GetService()?;
    client.Start()?;
    Ok((client, reader))
}

unsafe fn read_loop(reader: &IAudioCaptureClient, ready: HANDLE, stop: &Arc<AtomicBool>) -> windows::core::Result<()> {
    while !stop.load(Ordering::SeqCst) {
        // Wait for Windows' signal, but at most 100 ms, so a stop (or a silent program) is noticed.
        WaitForSingleObject(ready, 100);
        // Windows hands the sound over in "packets"; take every one that's ready.
        while reader.GetNextPacketSize()? > 0 {
            let mut data = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            reader.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
            let count = frames as usize * CHANNELS as usize;
            let samples: Vec<f32> = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                vec![0.0; count]  // (a silent packet's bytes mean nothing: silence)
            } else {
                std::slice::from_raw_parts(data as *const f32, count).to_vec()
            };
            reader.ReleaseBuffer(frames)?;
            let mut capture = CAPTURE.lock().unwrap();
            let Some(capture) = capture.as_mut() else {
                continue;  // (the very first packets, before start_app_audio has saved it)
            };
            if !Arc::ptr_eq(&capture.stop, stop) {
                return Ok(());  // a newer share's capture: ours was stopped, and this isn't for it
            }
            if capture.last_read.elapsed() > UNREAD_FOR {
                capture.stop.store(true, Ordering::SeqCst);
                break;
            }
            capture.waiting.extend_from_slice(&samples);
            if capture.waiting.len() > MAX_WAITING {
                let extra = capture.waiting.len() - MAX_WAITING;
                capture.waiting.drain(..extra);
            }
        }
    }
    Ok(())
}

// What Windows calls when the audio client is ready (or refused): wakes up `open`. Windows requires
// that any thread may call it ("agile"), which #[implement] objects always say they are.
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Done(Mutex<Option<mpsc::Sender<()>>>);

impl IActivateAudioInterfaceCompletionHandler_Impl for Done_Impl {
    fn ActivateCompleted(&self, _operation: Ref<IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
        if let Some(done) = self.0.lock().unwrap().take() {
            let _ = done.send(());
        }
        Ok(())
    }
}
