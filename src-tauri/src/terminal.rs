use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    env,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};
use tauri::{AppHandle, Emitter, Manager, State};

const MIN_TERMINAL_DIMENSION: u16 = 2;
const MAX_TERMINAL_DIMENSION: u16 = 500;
const MAX_TERMINAL_WRITE_BYTES: usize = 64 * 1024;

struct TerminalSession {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        if let Some(killer) = self.killer.as_mut() {
            let _ = killer.kill();
        }
    }
}

#[derive(Default)]
pub(crate) struct TerminalRuntime {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputEvent {
    terminal_id: String,
    data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitEvent {
    terminal_id: String,
    exit_code: Option<u32>,
    signal: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalInfo {
    terminal_id: String,
    working_directory: String,
    shell: String,
}

fn lock_sessions(
    runtime: &TerminalRuntime,
) -> Result<MutexGuard<'_, HashMap<String, TerminalSession>>, String> {
    runtime
        .sessions
        .lock()
        .map_err(|_| "The terminal service is unavailable.".to_string())
}

fn validate_terminal_id(terminal_id: &str) -> Result<(), String> {
    let valid = !terminal_id.is_empty()
        && terminal_id.len() <= 128
        && terminal_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if valid {
        Ok(())
    } else {
        Err("The terminal identifier is invalid.".to_string())
    }
}

fn terminal_size(cols: u16, rows: u16) -> Result<PtySize, String> {
    let valid = (MIN_TERMINAL_DIMENSION..=MAX_TERMINAL_DIMENSION).contains(&cols)
        && (MIN_TERMINAL_DIMENSION..=MAX_TERMINAL_DIMENSION).contains(&rows);
    if !valid {
        return Err("The terminal dimensions are invalid.".to_string());
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

fn resolve_working_directory(working_directory: Option<String>) -> Result<PathBuf, String> {
    let path = match working_directory {
        Some(path) if !path.trim().is_empty() => PathBuf::from(path),
        _ => env::var_os("HOME")
            .or_else(|| env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .or_else(|| env::current_dir().ok())
            .ok_or_else(|| "The current working directory is unavailable.".to_string())?,
    };
    let canonical = path
        .canonicalize()
        .map_err(|_| "The terminal working directory is unavailable.".to_string())?;
    if !canonical.is_dir() {
        return Err("The terminal working directory is not a folder.".to_string());
    }
    Ok(canonical)
}

fn shell_label(shell: &str) -> String {
    Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("shell")
        .to_string()
}

#[tauri::command]
pub(crate) fn terminal_start(
    app: AppHandle,
    state: State<'_, TerminalRuntime>,
    terminal_id: String,
    working_directory: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<TerminalInfo, String> {
    validate_terminal_id(&terminal_id)?;
    let size = terminal_size(cols, rows)?;
    let working_directory = resolve_working_directory(working_directory)?;

    if lock_sessions(&state)?.contains_key(&terminal_id) {
        return Err("That terminal is already running.".to_string());
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size)
        .map_err(|_| "Failed to create a terminal.".to_string())?;
    let mut command = CommandBuilder::new_default_prog();
    let shell = command.get_shell();
    command.cwd(&working_directory);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|_| "Failed to read terminal output.".to_string())?;
    let writer = Arc::new(Mutex::new(
        pair.master
            .take_writer()
            .map_err(|_| "Failed to prepare terminal input.".to_string())?,
    ));
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|_| "Failed to start the terminal shell.".to_string())?;
    let killer = child.clone_killer();
    drop(pair.slave);

    let session = TerminalSession {
        writer,
        master: pair.master,
        killer: Some(killer),
    };
    let mut sessions = lock_sessions(&state)?;
    if sessions.contains_key(&terminal_id) {
        return Err("That terminal is already running.".to_string());
    }
    sessions.insert(terminal_id.clone(), session);
    drop(sessions);

    let output_app = app.clone();
    let output_terminal_id = terminal_id.clone();
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            let Ok(read) = reader.read(&mut buffer) else {
                break;
            };
            if read == 0 {
                break;
            }
            let _ = output_app.emit(
                "groky://terminal-output",
                TerminalOutputEvent {
                    terminal_id: output_terminal_id.clone(),
                    data: buffer[..read].to_vec(),
                },
            );
        }
    });

    let wait_app = app.clone();
    let wait_terminal_id = terminal_id.clone();
    std::thread::spawn(move || {
        let (exit_code, signal) = match child.wait() {
            Ok(status) => (
                Some(status.exit_code()),
                status.signal().map(str::to_string),
            ),
            Err(_) => (None, None),
        };
        if let Ok(mut sessions) = wait_app.state::<TerminalRuntime>().sessions.lock() {
            if let Some(mut session) = sessions.remove(&wait_terminal_id) {
                session.killer.take();
            }
        }
        let _ = wait_app.emit(
            "groky://terminal-exit",
            TerminalExitEvent {
                terminal_id: wait_terminal_id,
                exit_code,
                signal,
            },
        );
    });

    Ok(TerminalInfo {
        terminal_id,
        working_directory: working_directory.to_string_lossy().into_owned(),
        shell: shell_label(&shell),
    })
}

#[tauri::command]
pub(crate) fn terminal_write(
    state: State<'_, TerminalRuntime>,
    terminal_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    validate_terminal_id(&terminal_id)?;
    if data.len() > MAX_TERMINAL_WRITE_BYTES {
        return Err("The terminal input is too large.".to_string());
    }
    let writer = lock_sessions(&state)?
        .get(&terminal_id)
        .map(|session| Arc::clone(&session.writer))
        .ok_or_else(|| "That terminal is no longer running.".to_string())?;
    let mut writer = writer
        .lock()
        .map_err(|_| "Terminal input is unavailable.".to_string())?;
    writer
        .write_all(&data)
        .and_then(|_| writer.flush())
        .map_err(|_| "Failed to write to the terminal.".to_string())
}

#[tauri::command]
pub(crate) fn terminal_resize(
    state: State<'_, TerminalRuntime>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    validate_terminal_id(&terminal_id)?;
    let size = terminal_size(cols, rows)?;
    lock_sessions(&state)?
        .get(&terminal_id)
        .ok_or_else(|| "That terminal is no longer running.".to_string())?
        .master
        .resize(size)
        .map_err(|_| "Failed to resize the terminal.".to_string())
}

#[tauri::command]
pub(crate) fn terminal_stop(
    state: State<'_, TerminalRuntime>,
    terminal_id: String,
) -> Result<(), String> {
    validate_terminal_id(&terminal_id)?;
    let session = lock_sessions(&state)?.remove(&terminal_id);
    drop(session);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{terminal_size, validate_terminal_id, MAX_TERMINAL_DIMENSION};

    #[test]
    fn accepts_safe_terminal_identifiers() {
        assert!(validate_terminal_id("terminal-42_abcd").is_ok());
        assert!(validate_terminal_id("").is_err());
        assert!(validate_terminal_id("terminal/42").is_err());
    }

    #[test]
    fn validates_terminal_dimensions() {
        assert!(terminal_size(80, 24).is_ok());
        assert!(terminal_size(1, 24).is_err());
        assert!(terminal_size(80, MAX_TERMINAL_DIMENSION + 1).is_err());
    }
}
