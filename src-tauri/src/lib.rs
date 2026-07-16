mod acp;

use acp::{AcpTransport, ApprovalMode};
use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
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
    models: Option<SessionModelState>,
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
    approval_mode: ApprovalMode,
    models: Option<SessionModelState>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionModelState {
    current_model_id: String,
    available_models: Vec<ModelInfo>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelInfo {
    model_id: String,
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(rename = "_meta", default)]
    metadata: Option<ModelMetadata>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelMetadata {
    #[serde(default)]
    total_context_tokens: Option<u64>,
    #[serde(default)]
    agent_type: Option<String>,
    #[serde(default)]
    supports_reasoning_effort: Option<bool>,
    #[serde(default)]
    reasoning_effort: Option<String>,
    #[serde(default)]
    reasoning_efforts: Vec<ReasoningEffortInfo>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReasoningEffortInfo {
    id: String,
    value: String,
    label: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(rename = "default", default)]
    is_default: bool,
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
fn configure_native_titlebar(window: tauri::WebviewWindow) -> Result<Option<f64>, String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSWindow, NSWindowButton};

        const MINIMUM_TITLEBAR_HEIGHT: f64 = 40.0;

        let ns_window_ptr = window
            .ns_window()
            .map_err(|error| format!("Failed to access the native window: {error}"))?
            as *mut NSWindow;
        let ns_window = unsafe { &*ns_window_ptr };
        let window_frame = ns_window.frame();
        let native_height = window_frame.size.height - ns_window.contentLayoutRect().size.height;
        let height = native_height.max(MINIMUM_TITLEBAR_HEIGHT);

        if let Some(close_button) = ns_window.standardWindowButton(NSWindowButton::CloseButton) {
            let button_parent = unsafe { close_button.superview() };
            let titlebar_container = button_parent
                .as_ref()
                .and_then(|parent| unsafe { parent.superview() });

            if let Some(container) = titlebar_container {
                let mut container_frame = container.frame();
                container_frame.size.height = height;
                container_frame.origin.y = window_frame.size.height - height;
                container.setFrame(container_frame);

                for kind in [
                    NSWindowButton::CloseButton,
                    NSWindowButton::MiniaturizeButton,
                    NSWindowButton::ZoomButton,
                ] {
                    let Some(button) = ns_window.standardWindowButton(kind) else {
                        continue;
                    };
                    let Some(parent) = (unsafe { button.superview() }) else {
                        continue;
                    };
                    let parent_frame = parent.frame();
                    let mut button_frame = button.frame();
                    button_frame.origin.y =
                        height / 2.0 - parent_frame.origin.y - button_frame.size.height / 2.0;
                    button.setFrameOrigin(button_frame.origin);
                }
            }
        }

        return Ok((height.is_finite() && height > 0.0 && height <= 96.0).then_some(height));
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Ok(None)
    }
}

#[tauri::command]
async fn check_app_update(
    app: AppHandle,
    state: State<'_, AppUpdateRuntime>,
) -> Result<Option<AppUpdateInfo>, String> {
    if state.installing.load(Ordering::Acquire) {
        return Err("An update is already being installed.".to_string());
    }

    let update = app
        .updater()
        .map_err(|error| format!("Failed to prepare the updater: {error}"))?
        .check()
        .await
        .map_err(|error| format!("Failed to check for updates: {error}"))?;
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
        return Err("An update is already being installed.".to_string());
    }

    let result = async {
        if grok_prompt_active(&grok).await {
            return Err("Stop the running task before updating.".to_string());
        }

        let update = state
            .pending
            .lock()
            .await
            .clone()
            .ok_or_else(|| "Check for updates before installing one.".to_string())?;

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
            .map_err(|error| format!("Failed to download the update: {error}"))?;

        if grok_prompt_active(&grok).await {
            return Err("Stop the running task before updating.".to_string());
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
            .map_err(|error| format!("Failed to install the update: {error}"))?;
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
                message: Some("Grok Build CLI was not found.".to_string()),
            })
        }
    };

    let cwd = suggested_workspace
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir);
    let transport = match AcpTransport::spawn(&cli.binary, &cwd, ApprovalMode::Ask, None).await {
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
        .map_err(|_| "Failed to start Grok sign-in.".to_string())?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to read the Grok authentication instructions.".to_string())?;
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
        Ok(Ok(_)) => Err("Grok sign-in did not complete.".to_string()),
        Ok(Err(_)) => Err("Failed to read the Grok sign-in result.".to_string()),
        Err(_) => {
            let _ = child.kill().await;
            Err("Sign-in timed out. Please try again.".to_string())
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
    .map_err(|_| "Sign-out timed out.".to_string())?
    .map_err(|_| "Failed to sign out of Grok.".to_string())?;

    if status.success() {
        Ok(())
    } else {
        Err("Failed to sign out of Grok.".to_string())
    }
}

#[tauri::command]
async fn choose_workspace() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Choose an existing folder for this project")
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| "Failed to open the folder picker.".to_string())
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
        .ok_or_else(|| "Start a task first.".to_string())?;
    open_directory(Path::new(&working_directory))
}

#[tauri::command]
async fn grok_connect(
    app: AppHandle,
    state: State<'_, GrokRuntime>,
    workspace: Option<String>,
    approval_mode: Option<ApprovalMode>,
) -> Result<ConnectResult, String> {
    let approval_mode = approval_mode.unwrap_or_default();
    let (workspace_path, selected_workspace) = if let Some(workspace) = workspace {
        let workspace_path = PathBuf::from(&workspace)
            .canonicalize()
            .map_err(|_| "Could not open the selected workspace.".to_string())?;
        if !workspace_path.is_dir() {
            return Err("Select a folder for the workspace.".to_string());
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

    let transport = AcpTransport::spawn(
        &cli.binary,
        &workspace_path,
        approval_mode,
        Some(app.clone()),
    )
    .await?;
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
    let Some(session_id) = result.get("sessionId").and_then(Value::as_str) else {
        transport.shutdown().await;
        return Err("Grok Build did not return a session ID.".to_string());
    };
    let session_id = session_id.to_string();
    let models = match parse_session_models(&result) {
        Ok(models) => models,
        Err(error) => {
            transport.shutdown().await;
            return Err(error);
        }
    };

    let session = GrokSession {
        transport,
        session_id: session_id.clone(),
        workspace: selected_workspace.clone(),
        working_directory: cwd.clone(),
        cli_version: cli.version.clone(),
        models: models.clone(),
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
        approval_mode,
        models,
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
        return Err("Enter a message.".to_string());
    }

    let session = state
        .session
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Not connected to Grok Build.".to_string())?;

    if session
        .prompt_active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("The previous request is still running.".to_string());
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
        .ok_or_else(|| "Not connected to Grok Build.".to_string())?;
    session.transport.cancel(&session.session_id).await
}

#[tauri::command]
async fn grok_set_model(
    state: State<'_, GrokRuntime>,
    model_id: String,
) -> Result<SessionModelState, String> {
    let session = state
        .session
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Not connected to Grok Build.".to_string())?;
    let mut models = session.models.clone().ok_or_else(|| {
        "Grok Build did not advertise model selection for this session.".to_string()
    })?;

    if !models
        .available_models
        .iter()
        .any(|model| model.model_id == model_id)
    {
        return Err("Choose a model advertised by Grok Build.".to_string());
    }
    if session.prompt_active.load(Ordering::Acquire) {
        return Err("Wait for the current request to finish before changing models.".to_string());
    }
    if models.current_model_id == model_id {
        return Ok(models);
    }

    session
        .transport
        .set_model(&session.session_id, &model_id, None)
        .await?;
    models.current_model_id = model_id;

    let mut active_session = state.session.lock().await;
    let Some(active_session) = active_session
        .as_mut()
        .filter(|active| active.session_id == session.session_id)
    else {
        return Err("The Grok Build session changed while selecting a model.".to_string());
    };
    active_session.models = Some(models.clone());

    Ok(models)
}

#[tauri::command]
async fn grok_set_reasoning_effort(
    state: State<'_, GrokRuntime>,
    reasoning_effort: String,
) -> Result<SessionModelState, String> {
    let session = state
        .session
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Not connected to Grok Build.".to_string())?;
    let mut models = session.models.clone().ok_or_else(|| {
        "Grok Build did not advertise reasoning controls for this session.".to_string()
    })?;
    let selected_effort = reasoning_effort_value(&models, &reasoning_effort)?;

    if session.prompt_active.load(Ordering::Acquire) {
        return Err(
            "Wait for the current request to finish before changing reasoning effort.".to_string(),
        );
    }

    let current_model = models.current_model_id.clone();
    let current_effort = models
        .available_models
        .iter()
        .find(|model| model.model_id == current_model)
        .and_then(|model| model.metadata.as_ref())
        .and_then(|metadata| metadata.reasoning_effort.as_deref());
    if current_effort == Some(selected_effort.as_str()) {
        return Ok(models);
    }

    session
        .transport
        .set_model(&session.session_id, &current_model, Some(&selected_effort))
        .await?;

    if let Some(metadata) = models
        .available_models
        .iter_mut()
        .find(|model| model.model_id == current_model)
        .and_then(|model| model.metadata.as_mut())
    {
        metadata.reasoning_effort = Some(selected_effort);
    }

    let mut active_session = state.session.lock().await;
    let Some(active_session) = active_session
        .as_mut()
        .filter(|active| active.session_id == session.session_id)
    else {
        return Err("The Grok Build session changed while selecting reasoning effort.".to_string());
    };
    active_session.models = Some(models.clone());

    Ok(models)
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
        .ok_or_else(|| "Not connected to Grok Build.".to_string())?;
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

fn parse_session_models(result: &Value) -> Result<Option<SessionModelState>, String> {
    let Some(models) = result.get("models") else {
        return Ok(None);
    };
    let models = serde_json::from_value::<SessionModelState>(models.clone())
        .map_err(|_| "Grok Build returned invalid model information.".to_string())?;
    let current_model_is_available = models
        .available_models
        .iter()
        .any(|model| model.model_id == models.current_model_id);
    if models.available_models.is_empty() || !current_model_is_available {
        return Err("Grok Build returned invalid model information.".to_string());
    }

    Ok(Some(models))
}

fn reasoning_effort_value(
    models: &SessionModelState,
    requested_effort: &str,
) -> Result<String, String> {
    let metadata = models
        .available_models
        .iter()
        .find(|model| model.model_id == models.current_model_id)
        .and_then(|model| model.metadata.as_ref())
        .ok_or_else(|| {
            "Grok Build did not advertise reasoning controls for the current model.".to_string()
        })?;

    if metadata.supports_reasoning_effort == Some(false) || metadata.reasoning_efforts.is_empty() {
        return Err(
            "Grok Build did not advertise reasoning controls for the current model.".to_string(),
        );
    }

    metadata
        .reasoning_efforts
        .iter()
        .find(|effort| effort.id == requested_effort || effort.value == requested_effort)
        .map(|effort| effort.value.clone())
        .ok_or_else(|| "Choose a reasoning effort advertised by Grok Build.".to_string())
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

    Err("Grok Build CLI was not found.".to_string())
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
        .map_err(|_| "Could not access the Documents folder.".to_string())?
        .join("Groky")
        .join(now.format("%Y-%m-%d").to_string());

    tokio::fs::create_dir_all(&parent)
        .await
        .map_err(|_| "Failed to prepare the Groky working directory.".to_string())?;

    for _ in 0..100 {
        let sequence = MANAGED_WORKSPACE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(managed_workspace_name(&now, sequence));
        match tokio::fs::create_dir(&candidate).await {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("Failed to prepare the Groky working directory.".to_string()),
        }
    }

    Err("Failed to prepare the Groky working directory.".to_string())
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
        .map_err(|_| "Failed to open the installation guide.".to_string())
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
        .map_err(|_| "Failed to open the working folder.".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(GrokRuntime::default())
        .manage(AppUpdateRuntime::default())
        .invoke_handler(tauri::generate_handler![
            configure_native_titlebar,
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
            grok_set_model,
            grok_set_reasoning_effort,
            grok_respond_permission,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        extract_device_auth_code, managed_workspace_name, parse_session_models,
        reasoning_effort_value,
    };
    use chrono::{Local, TimeZone};
    use serde_json::json;

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

    #[test]
    fn parses_models_advertised_by_the_grok_build_session() {
        let models = parse_session_models(&json!({
            "sessionId": "session-1",
            "models": {
                "currentModelId": "grok-4.5",
                "availableModels": [{
                    "modelId": "grok-4.5",
                    "name": "Grok 4.5",
                    "description": "Frontier model",
                    "_meta": {
                        "totalContextTokens": 500000,
                        "agentType": "grok-build-plan",
                        "supportsReasoningEffort": true,
                        "reasoningEffort": "high",
                        "reasoningEfforts": [
                            {
                                "id": "high",
                                "value": "high",
                                "label": "High Effort",
                                "description": "Highest implementation quality",
                                "default": true
                            },
                            {
                                "id": "medium",
                                "value": "medium",
                                "label": "Medium Effort",
                                "description": "Balanced effort",
                                "default": false
                            }
                        ]
                    }
                }]
            }
        }))
        .expect("valid model state")
        .expect("model selection should be present");

        assert_eq!(models.current_model_id, "grok-4.5");
        assert_eq!(models.available_models[0].name, "Grok 4.5");
        assert_eq!(
            models.available_models[0]
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.reasoning_effort.as_deref()),
            Some("high")
        );
        assert_eq!(
            models.available_models[0]
                .metadata
                .as_ref()
                .map(|metadata| metadata.reasoning_efforts.len()),
            Some(2)
        );
        assert_eq!(
            reasoning_effort_value(&models, "medium").as_deref(),
            Ok("medium")
        );
        assert!(reasoning_effort_value(&models, "unsupported").is_err());
    }

    #[test]
    fn rejects_an_unavailable_current_model() {
        assert!(parse_session_models(&json!({
            "models": {
                "currentModelId": "missing",
                "availableModels": [{ "modelId": "grok-4.5", "name": "Grok 4.5" }]
            }
        }))
        .is_err());
    }
}
