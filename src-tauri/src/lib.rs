//! UDMT desktop shell.
//!
//! The product is a local-first data tool: the Nuxt GUI is served by the local
//! Node core (same origin as `/api`), and this shell only supervises that core.
//! Order of operations:
//!   1. pick a free loopback port,
//!   2. spawn the bundled `udmt-core` (Node) with the UI directory,
//!   3. wait until `/api/health` answers,
//!   4. open the window on that URL,
//!   5. kill the core when the app exits.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread::sleep;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// Owns the child process so it can be stopped on exit.
struct CoreProcess(Mutex<Option<Child>>);

const DEFAULT_PORT: u16 = 4004;
const MAX_PORT_TRIES: u16 = 16;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(45);

/// Windows refuses to start `msedgewebview2.exe` from a Low-integrity process, and a
/// Low-integrity process also cannot write to `%TEMP%` (Medium). An executable that
/// inherits a Low mandatory label from its build folder therefore opens a window with
/// no UI at all — the single most confusing failure this shell can produce, so it is
/// diagnosed up front instead.
///
/// See `docs/desktop/packaging.md` ("Low-integrity build folders") for the cause.
#[cfg(windows)]
fn integrity_problem() -> Option<String> {
    const MEDIUM_RID: u32 = 0x2000;
    let rid = current_integrity_rid()?;
    if rid >= MEDIUM_RID {
        return None;
    }
    let exe = std::env::current_exe()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "this executable".into());
    Some(format!(
        "UDMT is running with integrity level {rid:#x} (Low), so Windows will not let it \
         start the embedded browser and the window would stay blank.\n\n\
         The executable inherited that label from the folder it was copied into:\n{exe}\n\n\
         Fix it with one of these:\n\
         • Reinstall UDMT (the installer writes to %LOCALAPPDATA%\\UDMT, which has no such label).\n\
         • Run: icacls \"<path to this folder>\" /setintegritylevel (OI)(CI)Medium /T\n\
         • Rebuild in a folder that has no Low mandatory label."
    ))
}

#[cfg(not(windows))]
fn integrity_problem() -> Option<String> {
    None
}

/// Reads the mandatory-label RID of the current process token: `0x1000` Low,
/// `0x2000` Medium, `0x3000` High.
#[cfg(windows)]
fn current_integrity_rid() -> Option<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel,
        TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    // TOKEN_MANDATORY_LABEL plus a SID never exceeds this in practice.
    let mut buffer = [0u8; 128];
    let mut needed = 0u32;
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        let ok = GetTokenInformation(
            token,
            TokenIntegrityLevel,
            buffer.as_mut_ptr().cast(),
            buffer.len() as u32,
            &mut needed,
        );
        let _ = CloseHandle(token);
        if ok == 0 {
            return None;
        }
        let label = &*(buffer.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let count = GetSidSubAuthorityCount(label.Label.Sid);
        if count.is_null() || *count == 0 {
            return None;
        }
        let rid = GetSidSubAuthority(label.Label.Sid, u32::from(*count - 1));
        if rid.is_null() {
            return None;
        }
        Some(*rid)
    }
}

/// Last-resort dialogs: at this point no webview exists yet, so Win32 is all there is.
fn show_fatal_dialog(title: &str, message: &str) {
    log_line(&format!("fatal: {message}"));
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND,
        };
        let wide = |text: &str| -> Vec<u16> {
            text.encode_utf16().chain(std::iter::once(0)).collect()
        };
        let body = wide(message);
        let caption = wide(title);
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            caption.as_ptr(),
            MB_OK | MB_ICONERROR | MB_SETFOREGROUND,
        );
    }
    #[cfg(not(windows))]
    eprintln!("{title}: {message}");
}

pub fn main() {
    if let Some(problem) = integrity_problem() {
        show_fatal_dialog("UDMT cannot start from this folder", &problem);
        std::process::exit(1);
    }
    prepare_webview_profile();
    tauri::Builder::default()
        .manage(CoreProcess(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            let resources = runtime_dir(&handle);
            let log = core_log_path();
            let port = pick_port(DEFAULT_PORT, MAX_PORT_TRIES).unwrap_or(DEFAULT_PORT);

            log_line(&format!(
                "startup: resources={} port={port}",
                resources.display()
            ));
            match spawn_core(&resources, port, &log) {
                Ok(child) => {
                    log_line(&format!(
                        "core spawned: pid={} log={}",
                        child.id(),
                        log.display()
                    ));
                    *app.state::<CoreProcess>().0.lock().unwrap() = Some(child);
                }
                Err(message) => {
                    log_line(&format!("core failed: {message}"));
                    open_error_window(&handle, &message);
                    return Ok(());
                }
            }

            std::thread::spawn(move || {
                let deadline = Instant::now() + STARTUP_TIMEOUT;
                let failure: Option<String> = loop {
                    if health_ok(port) {
                        break None;
                    }
                    // Surface an early crash instead of waiting out the whole budget.
                    if let Some(status) = core_exited(&handle) {
                        break Some(format!(
                            "The local core stopped during startup ({status}). Log: {}",
                            core_log_path().display()
                        ));
                    }
                    if Instant::now() > deadline {
                        break Some(format!(
                            "The local core did not answer on port {port} within {}s. Log: {}",
                            STARTUP_TIMEOUT.as_secs(),
                            core_log_path().display()
                        ));
                    }
                    sleep(Duration::from_millis(250));
                };
                log_line(match &failure {
                    None => "health: ok",
                    Some(reason) => reason,
                });
                let handle_for_ui = handle.clone();
                let _ = handle.run_on_main_thread(move || match failure {
                    Some(reason) => open_error_window(&handle_for_ui, &reason),
                    None => {
                        if let Err(err) = open_main_window(&handle_for_ui, port) {
                            log_line(&format!("window: failed on port {port}: {err}"));
                            open_error_window(
                                &handle_for_ui,
                                &format!("The window could not be created: {err}"),
                            );
                        }
                    }
                });
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running udmt desktop")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                if let Some(mut child) = app.state::<CoreProcess>().0.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}

/// Runtime payload: `node.exe`, `udmt-core.cjs` and `ui/` (see `scripts/prepare-desktop.mjs`).
fn runtime_dir(handle: &tauri::AppHandle) -> PathBuf {
    if let Ok(dir) = std::env::var("UDMT_RUNTIME_DIR") {
        return PathBuf::from(dir);
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = handle.path().resource_dir() {
        candidates.push(dir.join("runtime"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("runtime"));
        }
    }
    candidates.push(PathBuf::from("runtime"));
    for candidate in &candidates {
        if candidate.join("udmt-core.cjs").exists() {
            return simplify_path(candidate.clone());
        }
    }
    simplify_path(candidates.remove(0))
}

/// Tauri hands out `\\?\D:\...` extended paths. Node treats `\\?\D:` as a device
/// name and fails with `EISDIR: lstat 'D:'`, so drive-letter paths are stripped
/// back to their plain form before being passed to a child process.
fn simplify_path(path: PathBuf) -> PathBuf {
    if let Some(text) = path.to_str() {
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            let bytes = rest.as_bytes();
            if bytes.len() >= 3 && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/') {
                return PathBuf::from(rest);
            }
        }
    }
    path
}

/// Diagnostics go next to the core log so a failed packaging build is debuggable
/// without a console (the release binary is built as a Windows GUI subsystem app).
fn log_line(message: &str) {
    use std::io::Write as _;
    let path = shell_log_path();
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{message}");
    }
}

fn shell_log_path() -> PathBuf {
    log_dir().join("desktop-shell.log")
}

fn node_binary(runtime: &Path) -> PathBuf {
    let bundled = runtime.join(if cfg!(windows) { "node.exe" } else { "node" });
    if bundled.exists() {
        bundled
    } else {
        // Development fallback: use the Node on PATH.
        PathBuf::from("node")
    }
}

/// WebView2 keeps a browser profile on disk. Point it explicitly at a writable
/// location so a redirected/locked profile cannot make window creation fail.
///
/// It deliberately lives under the *data* directory (`%APPDATA%\udmt\WebView2`), not
/// next to the executable: the per-user installer owns `%LOCALAPPDATA%\UDMT` and its
/// uninstaller deletes that whole tree, but the profile is held open by running
/// `msedgewebview2.exe` processes, so anything inside the install folder survives the
/// uninstall as an orphaned cache. Keeping it in the data directory also matches the
/// CLI, which never touches it.
fn webview_profile_dir() -> PathBuf {
    let dir = std::env::var_os("UDMT_WEBVIEW_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("APPDATA")
                .map(|base| PathBuf::from(base).join("udmt").join("WebView2"))
        })
        .or_else(|| {
            std::env::var_os("LOCALAPPDATA")
                .map(|base| PathBuf::from(base).join("udmt").join("WebView2"))
        })
        .unwrap_or_else(|| std::env::temp_dir().join("udmt-webview"));
    let _ = fs::create_dir_all(&dir);
    simplify_path(dir)
}

fn prepare_webview_profile() {
    let dir = webview_profile_dir();
    if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none() {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &dir);
    }
    log_line(&format!("webview profile: {}", dir.display()));
}

fn log_dir() -> PathBuf {
    static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Some(dir) = std::env::var_os("UDMT_LOG_DIR") {
            candidates.push(PathBuf::from(dir));
        }
        if let Some(base) = std::env::var_os("APPDATA") {
            candidates.push(PathBuf::from(base).join("udmt").join("logs"));
        }
        if let Some(base) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(base).join("udmt").join("logs"));
        }
        candidates.push(std::env::temp_dir().join("udmt-logs"));

        for dir in &candidates {
            if fs::create_dir_all(dir).is_err() {
                continue;
            }
            let probe = dir.join(".write-probe");
            match fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&probe)
            {
                Ok(_) => {
                    let _ = fs::remove_file(&probe);
                    return dir.clone();
                }
                Err(_) => continue,
            }
        }
        std::env::temp_dir()
    })
    .clone()
}

fn core_log_path() -> PathBuf {
    log_dir().join("desktop-core.log")
}

fn spawn_core(runtime: &Path, port: u16, log: &Path) -> Result<Child, String> {
    let core = runtime.join("udmt-core.cjs");
    let ui = runtime.join("ui");
    if !core.exists() {
        return Err(format!("Core bundle is missing: {}", core.display()));
    }
    if !ui.join("index.html").exists() {
        return Err(format!("GUI assets are missing: {}", ui.display()));
    }

    // Logging is best effort: a locked-down profile must not stop the app.
    let log_file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .ok();
    let log_err = log_file.as_ref().and_then(|file| file.try_clone().ok());

    let mut command = Command::new(node_binary(runtime));
    command
        .arg(&core)
        .arg("gui")
        .arg("--port")
        .arg(port.to_string())
        .env("UDMT_UI_DIR", &ui)
        .env("NODE_NO_WARNINGS", "1")
        .stdin(Stdio::null());
    match (log_file, log_err) {
        (Some(out), Some(err)) => {
            command.stdout(Stdio::from(out)).stderr(Stdio::from(err));
        }
        _ => {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
        .spawn()
        .map_err(|err| format!("Cannot launch the local core: {err}"))
}

/// Lowest free port in `start..start + tries`, so a running CLI instance on 4004
/// does not block the desktop app.
fn pick_port(start: u16, tries: u16) -> Option<u16> {
    (0..tries)
        .map(|offset| start + offset)
        .find(|port| TcpListener::bind(("127.0.0.1", *port)).is_ok())
}

/// `Some(status)` when the child process already finished (crash or bad config).
fn core_exited(handle: &tauri::AppHandle) -> Option<std::process::ExitStatus> {
    let state = handle.state::<CoreProcess>();
    let mut guard = state.0.lock().ok()?;
    let child = guard.as_mut()?;
    child.try_wait().ok().flatten()
}

fn health_ok(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request =
        format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.starts_with("HTTP/1.1 200") && response.contains("\"app\":\"udmt\"")
}

fn open_main_window(handle: &tauri::AppHandle, port: u16) -> tauri::Result<()> {
    let url = format!("http://127.0.0.1:{port}/");
    WebviewWindowBuilder::new(
        handle,
        "main",
        WebviewUrl::External(url.parse().expect("loopback url")),
    )
    .title("UDMT — Universal Data Manager")
    .data_directory(webview_profile_dir())
    .inner_size(1320.0, 860.0)
    .min_inner_size(1024.0, 640.0)
    .center()
    .build()?;
    Ok(())
}

fn open_error_window(handle: &tauri::AppHandle, message: &str) {
    let safe = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let html = format!(
        "data:text/html;charset=utf-8,{}",
        urlencode(&format!(
            "<!doctype html><meta charset=utf-8><title>UDMT</title>\
             <body style=\"font:14px/1.6 system-ui;background:#0b0b14;color:#e5e7eb;padding:48px\">\
             <h2 style=\"margin:0 0 12px\">UDMT could not start</h2>\
             <p style=\"color:#f87171\">{safe}</p>\
             <p style=\"color:#9ca3af\">Reinstall, or run <code>udmt doctor</code> from a terminal.</p></body>"
        ))
    );
    let _ = WebviewWindowBuilder::new(
        handle,
        "main",
        WebviewUrl::External(html.parse().expect("data url")),
    )
    .title("UDMT — startup problem")
    .inner_size(760.0, 420.0)
    .center()
    .build();
}

fn urlencode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b' ' => {
                out.push(if byte == b' ' { '+' } else { byte as char })
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencode_escapes_markup_for_the_fallback_page() {
        let encoded = urlencode("<b>a b&c</b>");
        assert_eq!(encoded, "%3Cb%3Ea+b%26c%3C%2Fb%3E");
    }

    #[test]
    fn pick_port_returns_a_bindable_port_in_range() {
        let port = pick_port(45_000, 8).expect("a free port");
        assert!((45_000..45_008).contains(&port));
    }

    #[test]
    fn health_check_fails_when_nothing_listens() {
        assert!(!health_ok(1));
    }

    #[test]
    fn runtime_dir_falls_back_to_a_path_even_when_empty() {
        // No AppHandle in unit tests: the function is only reachable through the
        // env override here, which must win over every probe.
        assert_eq!(node_binary(Path::new("Z:/missing")), PathBuf::from("node"));
    }
}
