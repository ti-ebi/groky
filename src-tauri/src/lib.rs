mod acp;

use acp::AcpTransport;
use chrono::{DateTime, Local};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    env,
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::Mutex,
    time::timeout,
};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(60 * 5);
const AUTH_REQUIRED_ERROR: &str = "GROK_AUTH_REQUIRED";
const DEVICE_AUTH_URL_PREFIX: &str = "https://accounts.x.ai/oauth2/device?user_code=";
const INSTALL_GUIDE_URL: &str = "https://docs.x.ai/build/overview";
static MANAGED_WORKSPACE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
struct GrokSession {
    transport: AcpTransport,
    session_id: String,
    workspace: Option<String>,
    working_directory: String,
    cli_version: String,
    prompt_active: Arc<AtomicBool>,
}

#[derive(Default)]
struct GrokRuntime {
    session: Mutex<Option<GrokSession>>,
}

#[derive(Debug, Clone)]
struct CliInfo {
    binary: PathBuf,
    version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OnboardingStatus {
    stage: &'static str,
    cli_version: Option<String>,
    suggested_workspace: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectResult {
    session_id: String,
    workspace: Option<String>,
    working_directory: String,
    cli_version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptResult {
    stop_reason: Option<String>,
    text: String,
    thought: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionEvent {
    status: &'static str,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceAuthCodeEvent {
    code: String,
}

#[derive(Default)]
struct AppUpdateRuntime {
    pending: Mutex<Option<Update>>,
    installing: AtomicBool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateInfo {
    current_version: String,
    version: String,
    body: Option<String>,
    date: Option<String>,
}

impl From<&Update> for AppUpdateInfo {
    fn from(update: &Update) -> Self {
        Self {
            current_version: update.current_version.clone(),
            version: update.version.clone(),
            body: update.body.clone(),
            date: update.date.map(|date| date.to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateProgress {
    stage: &'static str,
    downloaded: u64,
    total: Option<u64>,
}

#[tauri::command]
async fn check_app_update(
    app: AppHandle,
    state: State<'_, AppUpdateRuntime>,
) -> Result<Option<AppUpdateInfo>, String> {
    if state.installing.load(Ordering::Acquire) {
        return Err("アップデートをインストールしています。".to_string());
    }

    let update = app
        .updater()
        .map_err(|error| format!("アップデートを準備できませんでした: {error}"))?
        .check()
        .await
        .map_err(|error| format!("アップデートを確認できませんでした: {error}"))?;
    let info = update.as_ref().map(AppUpdateInfo::from);
    *state.pending.lock().await = update;
    Ok(info)
}

#[tauri::command]
async fn install_app_update(
    app: AppHandle,
    grok: State<'_, GrokRuntime>,
    state: State<'_, AppUpdateRuntime>,
) -> Result<(), String> {
    if state
        .installing
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("アップデートをインストールしています。".to_string());
    }

    let result = async {
        if grok_prompt_active(&grok).await {
            return Err("実行中のタスクを停止してからアップデートしてください。".to_string());
        }

        let update = state
            .pending
            .lock()
            .await
            .clone()
            .ok_or_else(|| "先にアップデートを確認してください。".to_string())?;

        let _ = app.emit(
            "groky://update-progress",
            AppUpdateProgress {
                stage: "downloading",
                downloaded: 0,
                total: None,
            },
        );

        let progress_app = app.clone();
        let finished_app = app.clone();
        let mut downloaded = 0_u64;
        let bytes = update
            .download(
                move |chunk_length, total| {
                    downloaded = downloaded.saturating_add(chunk_length as u64);
                    let _ = progress_app.emit(
                        "groky://update-progress",
                        AppUpdateProgress {
                            stage: "downloading",
                            downloaded,
                            total,
                        },
                    );
                },
                move || {
                    let _ = finished_app.emit(
                        "groky://update-progress",
                        AppUpdateProgress {
                            stage: "downloaded",
                            downloaded: 0,
                            total: None,
                        },
                    );
                },
            )
            .await
            .map_err(|error| format!("アップデートをダウンロードできませんでした: {error}"))?;

        if grok_prompt_active(&grok).await {
            return Err("実行中のタスクを停止してからアップデートしてください。".to_string());
        }

        let package_size = bytes.len() as u64;
        let _ = app.emit(
            "groky://update-progress",
            AppUpdateProgress {
                stage: "installing",
                downloaded: package_size,
                total: Some(package_size),
            },
        );
        disconnect_runtime(&grok).await;
        update
            .install(&bytes)
            .map_err(|error| format!("アップデートをインストールできませんでした: {error}"))?;
        Ok(())
    }
    .await;

    state.installing.store(false, Ordering::Release);
    result?;
    *state.pending.lock().await = None;
    app.restart()
}

async fn grok_prompt_active(runtime: &GrokRuntime) -> bool {
    runtime
        .session
        .lock()
        .await
        .as_ref()
        .is_some_and(|session| session.prompt_active.load(Ordering::Acquire))
}

#[tauri::command]
async fn grok_status(state: State<'_, GrokRuntime>) -> Result<OnboardingStatus, String> {
    if let Some(session) = state.session.lock().await.as_ref() {
        return Ok(OnboardingStatus {
            stage: "connected",
            cli_version: Some(session.cli_version.clone()),
            suggested_workspace: session.workspace.clone(),
            message: None,
        });
    }

    let suggested_workspace = suggested_workspace();
    let cli = match resolve_cli().await {
        Ok(cli) => cli,
        Err(_) => {
            return Ok(OnboardingStatus {
                stage: "missingCli",
                cli_version: None,
                suggested_workspace,
                message: Some("Grok Build CLIが見つかりません。".to_string()),
            })
        }
    };

    let cwd = suggested_workspace
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir);
    let transport = match AcpTransport::spawn(&cli.binary, &cwd, None).await {
        Ok(transport) => transport,
        Err(message) => {
            return Ok(OnboardingStatus {
                stage: "error",
                cli_version: Some(cli.version),
                suggested_workspace,
                message: Some(message),
            })
        }
    };

    let auth_result = initialize_and_authenticate(&transport).await;
    transport.shutdown().await;

    match auth_result {
        Ok(()) => Ok(OnboardingStatus {
            stage: "ready",
            cli_version: Some(cli.version),
            suggested_workspace,
            message: None,
        }),
        Err(AuthError::NeedsLogin) => Ok(OnboardingStatus {
            stage: "needsAuth",
            cli_version: Some(cli.version),
            suggested_workspace,
            message: Some("Sign in to your Grok account to continue.".to_string()),
        }),
        Err(AuthError::Transport(message)) => Ok(OnboardingStatus {
            stage: "error",
            cli_version: Some(cli.version),
            suggested_workspace,
            message: Some(message),
        }),
    }
}

#[tauri::command]
async fn grok_login(app: AppHandle) -> Result<(), String> {
    let cli = resolve_cli().await?;
    let mut child = Command::new(&cli.binary)
        .args(["login", "--device-auth"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "Grokのサインインを開始できませんでした。".to_string())?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Grokの認証案内を確認できませんでした。".to_string())?;
    let reader = tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut code_emitted = false;
        while let Ok(Some(line)) = lines.next_line().await {
            if !code_emitted {
                if let Some(code) = extract_device_auth_code(&line) {
                    let _ = app.emit("grok://device-auth-code", DeviceAuthCodeEvent { code });
                    code_emitted = true;
                }
            }
        }
    });

    let result = match timeout(LOGIN_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(_)) => Err("Grokへのサインインが完了しませんでした。".to_string()),
        Ok(Err(_)) => Err("Grokのサインイン結果を確認できませんでした。".to_string()),
        Err(_) => {
            let _ = child.kill().await;
            Err("サインインがタイムアウトしました。もう一度お試しください。".to_string())
        }
    };
    reader.abort();
    result
}

#[tauri::command]
async fn grok_logout(state: State<'_, GrokRuntime>) -> Result<(), String> {
    disconnect_runtime(&state).await;
    let cli = resolve_cli().await?;
    let status = timeout(
        COMMAND_TIMEOUT,
        Command::new(&cli.binary)
            .arg("logout")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status(),
    )
    .await
    .map_err(|_| "サインアウトがタイムアウトしました。".to_string())?
    .map_err(|_| "Grokからサインアウトできませんでした。".to_string())?;

    if status.success() {
        Ok(())
    } else {
        Err("Grokからサインアウトできませんでした。".to_string())
    }
}

#[tauri::command]
async fn choose_workspace() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Grokyで開くワークスペースを選択")
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| "フォルダ選択を開けませんでした。".to_string())
}

#[tauri::command]
async fn open_grok_install_guide() -> Result<(), String> {
    open_url(INSTALL_GUIDE_URL)
}

#[tauri::command]
async fn reveal_working_directory(state: State<'_, GrokRuntime>) -> Result<(), String> {
    let working_directory = state
        .session
        .lock()
        .await
        .as_ref()
        .map(|session| session.working_directory.clone())
        .ok_or_else(|| "先にタスクを開始してください。".to_string())?;
    open_directory(Path::new(&working_directory))
}

#[tauri::command]
async fn grok_connect(
    app: AppHandle,
    state: State<'_, GrokRuntime>,
    workspace: Option<String>,
) -> Result<ConnectResult, String> {
    let (workspace_path, selected_workspace) = if let Some(workspace) = workspace {
        let workspace_path = PathBuf::from(&workspace)
            .canonicalize()
            .map_err(|_| "選択したワークスペースを開けません。".to_string())?;
        if !workspace_path.is_dir() {
            return Err("ワークスペースにはフォルダを選択してください。".to_string());
        }
        let selected_workspace = workspace_path.to_string_lossy().into_owned();
        (workspace_path, Some(selected_workspace))
    } else {
        let workspace_path = create_managed_workspace(&app).await?;
        (workspace_path, None)
    };
    let cwd = workspace_path.to_string_lossy().into_owned();
    let cli = resolve_cli().await?;

    disconnect_runtime(&state).await;

    let transport = AcpTransport::spawn(&cli.binary, &workspace_path, Some(app.clone())).await?;
    if let Err(error) = initialize_and_authenticate(&transport).await {
        transport.shutdown().await;
        return Err(match error {
            AuthError::NeedsLogin => AUTH_REQUIRED_ERROR.to_string(),
            AuthError::Transport(message) => message,
        });
    }

    let result = transport
        .request("session/new", json!({ "cwd": cwd, "mcpServers": [] }))
        .await;
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            transport.shutdown().await;
            return Err(error);
        }
    };
    let session_id = result
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Grok BuildがセッションIDを返しませんでした。".to_string())?
        .to_string();

    let session = GrokSession {
        transport,
        session_id: session_id.clone(),
        workspace: selected_workspace.clone(),
        working_directory: cwd.clone(),
        cli_version: cli.version.clone(),
        prompt_active: Arc::new(AtomicBool::new(false)),
    };
    *state.session.lock().await = Some(session);

    let _ = app.emit(
        "grok://connection",
        ConnectionEvent {
            status: "connected",
            message: None,
        },
    );

    Ok(ConnectResult {
        session_id,
        workspace: selected_workspace,
        working_directory: cwd,
        cli_version: cli.version,
    })
}

#[tauri::command]
async fn grok_disconnect(state: State<'_, GrokRuntime>) -> Result<(), String> {
    disconnect_runtime(&state).await;
    Ok(())
}

#[tauri::command]
async fn grok_prompt(
    state: State<'_, GrokRuntime>,
    prompt: String,
) -> Result<PromptResult, String> {
    if prompt.trim().is_empty() {
        return Err("メッセージを入力してください。".to_string());
    }

    let session = state
        .session
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Grok Buildに接続されていません。".to_string())?;

    if session
        .prompt_active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("前のリクエストがまだ実行中です。".to_string());
    }

    let result = session
        .transport
        .prompt(&session.session_id, prompt.trim())
        .await;
    session.prompt_active.store(false, Ordering::Release);

    let (result, output) = result?;
    Ok(PromptResult {
        stop_reason: result
            .get("stopReason")
            .and_then(Value::as_str)
            .map(str::to_string),
        text: output.text,
        thought: output.thought,
    })
}

#[tauri::command]
async fn grok_cancel(state: State<'_, GrokRuntime>) -> Result<(), String> {
    let session = state
        .session
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Grok Buildに接続されていません。".to_string())?;
    session.transport.cancel(&session.session_id).await
}

#[tauri::command]
async fn grok_respond_permission(
    state: State<'_, GrokRuntime>,
    request_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    let session = state
        .session
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Grok Buildに接続されていません。".to_string())?;
    session
        .transport
        .respond_permission(&request_id, option_id.as_deref())
        .await
}

#[derive(Debug)]
enum AuthError {
    NeedsLogin,
    Transport(String),
}

async fn initialize_and_authenticate(transport: &AcpTransport) -> Result<(), AuthError> {
    let init = transport
        .request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {},
                "clientInfo": {
                    "name": "Groky",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
        )
        .await
        .map_err(AuthError::Transport)?;

    let auth_methods = init
        .get("authMethods")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let method_id = ["cached_token", "xai.api_key"]
        .into_iter()
        .find(|candidate| {
            auth_methods
                .iter()
                .any(|method| method.get("id").and_then(Value::as_str) == Some(*candidate))
        });
    let Some(method_id) = method_id else {
        return Err(AuthError::NeedsLogin);
    };

    transport
        .request(
            "authenticate",
            json!({ "methodId": method_id, "_meta": { "headless": true } }),
        )
        .await
        .map_err(|_| AuthError::NeedsLogin)?;
    Ok(())
}

async fn disconnect_runtime(state: &GrokRuntime) {
    let old_session = state.session.lock().await.take();
    if let Some(session) = old_session {
        session.transport.shutdown().await;
    }
}

fn extract_device_auth_code(line: &str) -> Option<String> {
    let start = line.find(DEVICE_AUTH_URL_PREFIX)? + DEVICE_AUTH_URL_PREFIX.len();
    let code = line[start..]
        .chars()
        .take_while(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || *character == '-'
        })
        .collect::<String>();

    let mut groups = code.split('-');
    let first = groups.next()?;
    let second = groups.next()?;
    if groups.next().is_none()
        && first.len() == 4
        && second.len() == 4
        && first
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
        && second
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        Some(code)
    } else {
        None
    }
}

fn suggested_workspace() -> Option<String> {
    env::current_dir()
        .ok()
        .filter(|path| {
            path.is_dir()
                && [".git", "package.json", "Cargo.toml", "AGENTS.md"]
                    .iter()
                    .any(|marker| path.join(marker).exists())
        })
        .map(|path| path.to_string_lossy().into_owned())
}

async fn resolve_cli() -> Result<CliInfo, String> {
    let mut candidates = Vec::new();
    if let Some(binary) = env::var_os("GROK_BINARY") {
        candidates.push(PathBuf::from(binary));
    }
    candidates.push(PathBuf::from(if cfg!(windows) {
        "grok.exe"
    } else {
        "grok"
    }));

    if let Some(home) = home_dir() {
        let executable = if cfg!(windows) { "grok.exe" } else { "grok" };
        candidates.push(home.join(".local").join("bin").join(executable));
        candidates.push(home.join(".grok").join("bin").join(executable));
    }

    for candidate in candidates {
        let output = timeout(
            COMMAND_TIMEOUT,
            Command::new(&candidate)
                .arg("version")
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output(),
        )
        .await;
        let Ok(Ok(output)) = output else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if version.starts_with("grok ") {
            return Ok(CliInfo {
                binary: candidate,
                version,
            });
        }
    }

    Err("Grok Build CLIが見つかりません。".to_string())
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

async fn create_managed_workspace(app: &AppHandle) -> Result<PathBuf, String> {
    let now = Local::now();
    let parent = app
        .path()
        .document_dir()
        .map_err(|_| "Documentsフォルダを開けませんでした。".to_string())?
        .join("Groky")
        .join(now.format("%Y-%m-%d").to_string());

    tokio::fs::create_dir_all(&parent)
        .await
        .map_err(|_| "Grokyの作業ディレクトリを準備できません。".to_string())?;

    for _ in 0..100 {
        let sequence = MANAGED_WORKSPACE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(managed_workspace_name(&now, sequence));
        match tokio::fs::create_dir(&candidate).await {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("Grokyの作業ディレクトリを準備できません。".to_string()),
        }
    }

    Err("Grokyの作業ディレクトリを準備できません。".to_string())
}

fn managed_workspace_name(now: &DateTime<Local>, sequence: u64) -> String {
    let millis = now.timestamp_subsec_millis();
    format!(
        "task-{}-{millis:03}-{sequence:04x}",
        now.format("%H%M%S"),
        sequence = sequence & 0xffff
    )
}

fn open_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "macos")]
    command.arg(url);

    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "linux")]
    command.arg(url);

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "start", "", url]);
        command
    };

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|_| "インストールガイドを開けませんでした。".to_string())
}

fn open_directory(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "macos")]
    command.arg(path);

    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "linux")]
    command.arg(path);

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("explorer");
        command.arg(path);
        command
    };

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|_| "作業フォルダを開けませんでした。".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(GrokRuntime::default())
        .manage(AppUpdateRuntime::default())
        .invoke_handler(tauri::generate_handler![
            check_app_update,
            install_app_update,
            grok_status,
            grok_login,
            grok_logout,
            choose_workspace,
            open_grok_install_guide,
            reveal_working_directory,
            grok_connect,
            grok_disconnect,
            grok_prompt,
            grok_cancel,
            grok_respond_permission,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{extract_device_auth_code, managed_workspace_name};
    use chrono::{Local, TimeZone};

    #[test]
    fn extracts_the_device_code_from_the_official_xai_url() {
        assert_eq!(
            extract_device_auth_code("  https://accounts.x.ai/oauth2/device?user_code=AB12-CD34\r")
                .as_deref(),
            Some("AB12-CD34")
        );
    }

    #[test]
    fn ignores_codes_from_untrusted_or_malformed_urls() {
        assert!(
            extract_device_auth_code("https://example.com/oauth2/device?user_code=AB12-CD34")
                .is_none()
        );
        assert!(
            extract_device_auth_code("https://accounts.x.ai/oauth2/device?user_code=TOO-LONG")
                .is_none()
        );
    }

    #[test]
    fn creates_a_private_task_directory_name_without_prompt_text() {
        let now = Local
            .with_ymd_and_hms(2026, 7, 17, 9, 8, 7)
            .single()
            .expect("valid local date");
        let name = managed_workspace_name(&now, 0x2a);

        assert!(name.starts_with("task-090807-"));
        assert!(name.ends_with("-002a"));
    }
}
