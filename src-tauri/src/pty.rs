//! PTY session management.
//!
//! Spawns a shell process attached to a pseudo-terminal, streams its output
//! to the frontend via Tauri events, and exposes commands to write input and
//! resize the terminal.
//!
//! Phase 2 of the Prism plan.

use std::io::{Read, Write};
use std::sync::Arc;
use std::thread;

use dashmap::DashMap;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

/// A single PTY session: master side (for resize), a writer (stdin), and the
/// child process handle (for kill).
pub struct PtySession {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

/// Registry of live PTY sessions, keyed by a UUID string.
#[derive(Default)]
pub struct PtyState {
    sessions: DashMap<String, Arc<PtySession>>,
}

/// Spawn the user's default shell in a new PTY.
///
/// Returns a session id that the frontend uses for subsequent calls and for
/// subscribing to the `pty-output-<id>` / `pty-exit-<id>` events.
#[tauri::command]
pub fn spawn_shell(
    app: AppHandle,
    state: State<'_, PtyState>,
    cols: Option<u16>,
    rows: Option<u16>,
    // Optional id to use for this session. If absent, a fresh UUID is
    // generated. The frontend passes a value so it can subscribe to
    // `pty-output-<id>` events without a round-trip.
    session_id: Option<String>,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let size = PtySize {
        rows: rows.unwrap_or(30),
        cols: cols.unwrap_or(100),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("LANG", std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".into()));

    // If the user's shell is zsh, drop Prism's ZDOTDIR in so the OSC 133
    // hooks get installed on top of their existing zshrc. Failures here are
    // non-fatal; the terminal still works without block segmentation.
    if shell.ends_with("zsh") {
        match crate::shell_integration::setup_zsh_zdotdir() {
            Ok(zdotdir) => {
                cmd.env("ZDOTDIR", zdotdir.to_string_lossy().to_string());
                cmd.env("PRISM_SHELL_INTEGRATION", "1");
            }
            Err(e) => eprintln!("prism: shell integration setup failed: {}", e),
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        cmd.cwd(home);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // Drop the parent's handle to the slave; the child process keeps it.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let session_id = session_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let output_event = format!("pty-output-{}", session_id);
    let exit_event = format!("pty-exit-{}", session_id);

    // Reader thread: blocking reads from the PTY master, emit chunks as
    // Tauri events until EOF.
    {
        let app_handle = app.clone();
        let output_event = output_event.clone();
        let exit_event = exit_event.clone();
        thread::Builder::new()
            .name(format!("pty-reader-{}", session_id))
            .spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            // String::from_utf8_lossy handles multi-byte chars that
                            // may land on the boundary of the buffer. xterm.js is
                            // fine receiving lossy output; proper UTF-8 framing can
                            // be added later if needed.
                            let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                            let _ = app_handle.emit(&output_event, chunk);
                        }
                        Err(_) => break,
                    }
                }
                let _ = app_handle.emit(&exit_event, ());
            })
            .map_err(|e| e.to_string())?;
    }

    let session = Arc::new(PtySession {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
    });
    state.sessions.insert(session_id.clone(), session);

    Ok(session_id)
}

/// Write raw bytes to the PTY stdin (keystrokes from xterm.js).
#[tauri::command]
pub fn write_to_shell(
    session_id: String,
    data: String,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("session {} not found", session_id))?
        .clone();
    let mut writer = session.writer.lock();
    writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Resize the PTY so that line-wrapping / TUI apps behave correctly.
#[tauri::command]
pub fn resize_shell(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("session {} not found", session_id))?
        .clone();
    let master = session.master.lock();
    master
        .resize(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Kill the child shell and drop the session.
#[tauri::command]
pub fn kill_shell(session_id: String, state: State<'_, PtyState>) -> Result<(), String> {
    if let Some((_, session)) = state.sessions.remove(&session_id) {
        let _ = session.child.lock().kill();
    }
    Ok(())
}
