mod acp;
mod file_manager;
mod terminal;

use acp::{
    normalize_stop_reason, AcpTransport, ApprovalMode, PromptResourceLink, SafeAvailableCommand,
    SessionUpdateEvent,
};
use chrono::{DateTime, Local};
use file_manager::{
    workspace_inspect_attachment, workspace_list_directory, workspace_open_folder,
    workspace_preview_file, workspace_unwatch, workspace_watch, WorkspaceWatcherRuntime,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
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
use terminal::{terminal_resize, terminal_start, terminal_stop, terminal_write, TerminalRuntime};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::Mutex,
    time::timeout,
};
use url::Url;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(60 * 5);
const AUTH_REQUIRED_ERROR: &str = "GROK_AUTH_REQUIRED";
const DEVICE_AUTH_URL_PREFIX: &str = "https://accounts.x.ai/oauth2/device?user_code=";
const INSTALL_GUIDE_URL: &str = "https://docs.x.ai/build/overview";
const SESSION_HISTORY_FILE: &str = "sessions.json";
const WORKSPACE_HISTORY_FILE: &str = "working-directories.json";
const DEFAULT_SESSION_TITLE: &str = "New Grok session";
const MAX_SESSION_TITLE_CHARS: usize = 72;
const MAX_ATTACHMENTS: usize = 10;
const MAX_AUTH_FILE_BYTES: usize = 1024 * 1024;
const MAX_ACCOUNT_FIELD_CHARS: usize = 320;
static MANAGED_WORKSPACE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
struct GrokSession {
    transport: AcpTransport,
    session_id: String,
    workspace: Option<String>,
    working_directory: String,
    cli_version: String,
    approval_mode: ApprovalMode,
    models: Option<SessionModelState>,
    available_commands: Vec<SafeAvailableCommand>,
    prompt_active: Arc<AtomicBool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct TransportKey {
    working_directory: String,
    approval_mode: ApprovalMode,
}

#[derive(Clone)]
struct ManagedTransport {
    transport: AcpTransport,
    capabilities: AgentCapabilities,
}

#[derive(Default)]
struct GrokRuntimeState {
    sessions: HashMap<String, GrokSession>,
    transports: HashMap<TransportKey, ManagedTransport>,
    active_session_id: Option<String>,
}

#[derive(Default)]
struct GrokRuntime {
    inner: Mutex<GrokRuntimeState>,
    history: Mutex<()>,
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
    account_profile: Option<AccountProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountProfile {
    display_name: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectResult {
    session_id: String,
    workspace: Option<String>,
    working_directory: String,
    cli_version: String,
    approval_mode: ApprovalMode,
    models: Option<SessionModelState>,
    available_commands: Vec<SafeAvailableCommand>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadSessionResult {
    connection: ConnectResult,
    updates: Vec<SessionUpdateEvent>,
}

impl From<&GrokSession> for ConnectResult {
    fn from(session: &GrokSession) -> Self {
        Self {
            session_id: session.session_id.clone(),
            workspace: session.workspace.clone(),
            working_directory: session.working_directory.clone(),
            cli_version: session.cli_version.clone(),
            approval_mode: session.approval_mode,
            models: session.models.clone(),
            available_commands: session.available_commands.clone(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSession {
    session_id: String,
    title: String,
    workspace: Option<String>,
    working_directory: String,
    approval_mode: ApprovalMode,
    created_at: i64,
    updated_at: i64,
    #[serde(default)]
    archived: bool,
    #[serde(default)]
    unread: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionSummary {
    session_id: String,
    title: String,
    workspace: Option<String>,
    updated_at: i64,
    archived: bool,
    unread: bool,
}

impl From<&PersistedSession> for SessionSummary {
    fn from(session: &PersistedSession) -> Self {
        Self {
            session_id: session.session_id.clone(),
            title: session.title.clone(),
            workspace: session.workspace.clone(),
            updated_at: session.updated_at,
            archived: session.archived,
            unread: session.unread,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedWorkspace {
    path: String,
    created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSummary {
    path: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum SessionHistoryAction {
    Archive,
    Restore,
    Delete,
}

#[derive(Debug, Clone, Copy)]
struct AgentCapabilities {
    load_session: bool,
}

struct InitializedAgent {
    capabilities: AgentCapabilities,
    response: Value,
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
    #[serde(rename(serialize = "metadata", deserialize = "_meta"), default)]
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
    stop_reason: String,
    text: String,
    thought: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileAttachment {
    path: String,
    name: String,
    size: i64,
    mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionEvent {
    status: &'static str,
    message: Option<String>,
    session_ids: Vec<String>,
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
            return Err("Stop the active turn before updating.".to_string());
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
            return Err("Stop the active turn before updating.".to_string());
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
        .inner
        .lock()
        .await
        .sessions
        .values()
        .any(|session| session.prompt_active.load(Ordering::Acquire))
}

#[tauri::command]
async fn grok_status(state: State<'_, GrokRuntime>) -> Result<OnboardingStatus, String> {
    let active_session = {
        let runtime = state.inner.lock().await;
        runtime
            .active_session_id
            .as_deref()
            .and_then(|session_id| runtime.sessions.get(session_id))
            .cloned()
    };
    if let Some(session) = active_session {
        let account_profile = read_account_profile().await;
        return Ok(OnboardingStatus {
            stage: "connected",
            cli_version: Some(session.cli_version.clone()),
            suggested_workspace: session.workspace.clone(),
            message: None,
            account_profile,
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
                account_profile: None,
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
                account_profile: None,
            })
        }
    };

    let auth_result = initialize_and_authenticate(&transport).await;
    transport.shutdown().await;

    match auth_result {
        Ok(_) => {
            let account_profile = read_account_profile().await;
            Ok(OnboardingStatus {
                stage: "ready",
                cli_version: Some(cli.version),
                suggested_workspace,
                message: None,
                account_profile,
            })
        }
        Err(AuthError::NeedsLogin) => Ok(OnboardingStatus {
            stage: "needsAuth",
            cli_version: Some(cli.version),
            suggested_workspace,
            message: Some("Sign in to your Grok account to continue.".to_string()),
            account_profile: None,
        }),
        Err(AuthError::Transport(message)) => Ok(OnboardingStatus {
            stage: "error",
            cli_version: Some(cli.version),
            suggested_workspace,
            message: Some(message),
            account_profile: None,
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
            .set_title("Choose a working directory for this session")
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| "Failed to open the folder picker.".to_string())
}

fn inspect_attachment_paths(paths: Vec<PathBuf>) -> Result<Vec<FileAttachment>, String> {
    let mut seen = HashSet::new();
    let mut attachments = Vec::new();

    for path in paths {
        let canonical = path
            .canonicalize()
            .map_err(|_| "One of the selected files is no longer available.".to_string())?;
        if !seen.insert(canonical.clone()) {
            continue;
        }
        if attachments.len() == MAX_ATTACHMENTS {
            return Err(format!("Attach up to {MAX_ATTACHMENTS} files at a time."));
        }

        let metadata = canonical
            .metadata()
            .map_err(|_| "One of the selected files could not be inspected.".to_string())?;
        if !metadata.is_file() {
            return Err("Only files can be attached to a message.".to_string());
        }
        let size = i64::try_from(metadata.len())
            .map_err(|_| "One of the selected files is too large to attach.".to_string())?;
        let name = canonical
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| !name.is_empty())
            .ok_or_else(|| "One of the selected files has no usable name.".to_string())?;

        attachments.push(FileAttachment {
            path: canonical.to_string_lossy().into_owned(),
            name,
            size,
            mime_type: mime_guess::from_path(&canonical)
                .first_raw()
                .map(str::to_string),
        });
    }

    Ok(attachments)
}

async fn inspect_attachment_path_strings(
    paths: Vec<String>,
) -> Result<Vec<FileAttachment>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        inspect_attachment_paths(paths.into_iter().map(PathBuf::from).collect())
    })
    .await
    .map_err(|_| "Failed to inspect the selected files.".to_string())?
}

#[tauri::command]
async fn choose_attachments() -> Result<Vec<FileAttachment>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(paths) = rfd::FileDialog::new()
            .set_title("Attach files to this message")
            .pick_files()
        else {
            return Ok(Vec::new());
        };
        inspect_attachment_paths(paths)
    })
    .await
    .map_err(|_| "Failed to open the file picker.".to_string())?
}

#[tauri::command]
async fn inspect_attachments(paths: Vec<String>) -> Result<Vec<FileAttachment>, String> {
    inspect_attachment_path_strings(paths).await
}

fn attachment_resource_links(
    attachments: &[FileAttachment],
) -> Result<Vec<PromptResourceLink>, String> {
    attachments
        .iter()
        .map(|attachment| {
            let uri = Url::from_file_path(Path::new(&attachment.path))
                .map_err(|_| "One of the selected file paths could not be attached.".to_string())?;
            Ok(PromptResourceLink {
                uri: uri.to_string(),
                name: attachment.name.clone(),
                mime_type: attachment.mime_type.clone(),
                size: attachment.size,
            })
        })
        .collect()
}

#[tauri::command]
async fn open_grok_install_guide() -> Result<(), String> {
    open_url(INSTALL_GUIDE_URL)
}

#[tauri::command]
async fn grok_list_sessions(app: AppHandle) -> Result<Vec<SessionSummary>, String> {
    Ok(read_session_history(&app)
        .await?
        .iter()
        .map(SessionSummary::from)
        .collect())
}

#[tauri::command]
async fn grok_rename_session(
    app: AppHandle,
    state: State<'_, GrokRuntime>,
    session_id: String,
    title: String,
) -> Result<SessionSummary, String> {
    let title = normalize_session_title(&title)?;
    let _history = state.history.lock().await;
    let mut sessions = read_session_history(&app).await?;
    let summary = rename_session_title(&mut sessions, &session_id, title)
        .ok_or_else(|| "That session is no longer in Groky history.".to_string())?;
    write_session_history(&app, &sessions).await?;
    Ok(summary)
}

#[tauri::command]
async fn grok_list_workspaces(app: AppHandle) -> Result<Vec<WorkspaceSummary>, String> {
    let history_exists = tokio::fs::try_exists(workspace_history_path(&app)?)
        .await
        .map_err(|_| "Could not read Groky working directories.".to_string())?;
    let mut workspaces = read_workspace_history(&app).await?;
    if !history_exists {
        for session in read_session_history(&app).await? {
            let Some(path) = session.workspace else {
                continue;
            };
            upsert_workspace_history(
                &mut workspaces,
                PersistedWorkspace {
                    path,
                    created_at: session.created_at,
                },
            );
        }
        write_workspace_history(&app, &workspaces).await?;
    }
    workspaces.sort_by(|left, right| left.created_at.cmp(&right.created_at));
    Ok(workspaces
        .into_iter()
        .map(|workspace| WorkspaceSummary {
            path: workspace.path,
        })
        .collect())
}

#[tauri::command]
async fn grok_add_workspace(app: AppHandle, workspace: String) -> Result<WorkspaceSummary, String> {
    let workspace_path = PathBuf::from(&workspace)
        .canonicalize()
        .map_err(|_| "Could not open the selected working directory.".to_string())?;
    if !workspace_path.is_dir() {
        return Err("Choose a folder to use as a working directory.".to_string());
    }
    let path = workspace_path.to_string_lossy().into_owned();
    persist_workspace(&app, &path).await?;
    Ok(WorkspaceSummary { path })
}

#[tauri::command]
async fn grok_remove_workspace(
    app: AppHandle,
    workspace: String,
) -> Result<Vec<WorkspaceSummary>, String> {
    let mut workspaces = read_workspace_history(&app).await?;
    if !remove_workspace_history(&mut workspaces, &workspace) {
        return Err("This working directory is not in Groky.".to_string());
    }
    write_workspace_history(&app, &workspaces).await?;
    Ok(workspaces
        .into_iter()
        .map(|workspace| WorkspaceSummary {
            path: workspace.path,
        })
        .collect())
}

#[tauri::command]
async fn grok_mutate_sessions(
    app: AppHandle,
    state: State<'_, GrokRuntime>,
    action: SessionHistoryAction,
    session_id: Option<String>,
    workspace: Option<String>,
) -> Result<Vec<SessionSummary>, String> {
    if session_id.is_some() == workspace.is_some() {
        return Err("Choose either one session or one working directory.".to_string());
    }

    let _history = state.history.lock().await;
    let mut sessions = read_session_history(&app).await?;
    let session_id = session_id.as_deref();
    let workspace = workspace.as_deref();
    if !sessions
        .iter()
        .any(|session| session_matches_history_target(session, session_id, workspace))
    {
        return Err("No matching sessions were found.".to_string());
    }

    let affected_ids = sessions
        .iter()
        .filter(|session| session_matches_history_target(session, session_id, workspace))
        .map(|session| session.session_id.clone())
        .collect::<Vec<_>>();
    let forgotten_sessions = {
        let mut runtime = state.inner.lock().await;
        if affected_ids.iter().any(|session_id| {
            runtime
                .sessions
                .get(session_id)
                .is_some_and(|session| session.prompt_active.load(Ordering::Acquire))
        }) {
            return Err("Stop active turns before changing their history.".to_string());
        }

        if !matches!(action, SessionHistoryAction::Restore)
            && runtime
                .active_session_id
                .as_ref()
                .is_some_and(|active| affected_ids.contains(active))
        {
            runtime.active_session_id = None;
        }
        if matches!(action, SessionHistoryAction::Delete) {
            affected_ids
                .iter()
                .filter_map(|session_id| {
                    runtime
                        .sessions
                        .remove(session_id)
                        .map(|session| (session_id.clone(), session.transport))
                })
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        }
    };

    apply_session_history_action(&mut sessions, action, session_id, workspace);
    write_session_history(&app, &sessions).await?;
    for (session_id, transport) in forgotten_sessions {
        transport.forget_session(&session_id).await;
    }
    Ok(sessions.iter().map(SessionSummary::from).collect())
}

fn auth_error_message(error: AuthError) -> String {
    match error {
        AuthError::NeedsLogin => AUTH_REQUIRED_ERROR.to_string(),
        AuthError::Transport(message) => message,
    }
}

async fn acquire_transport(
    app: &AppHandle,
    state: &GrokRuntime,
    cli: &CliInfo,
    workspace_path: &Path,
    working_directory: &str,
    approval_mode: ApprovalMode,
) -> Result<ManagedTransport, String> {
    let key = TransportKey {
        working_directory: working_directory.to_string(),
        approval_mode,
    };
    {
        let mut runtime = state.inner.lock().await;
        if let Some(transport) = runtime.transports.get(&key).cloned() {
            if transport.transport.is_alive() {
                return Ok(transport);
            }
            runtime.transports.remove(&key);
        }
    }

    let transport = AcpTransport::spawn(
        &cli.binary,
        workspace_path,
        approval_mode,
        Some(app.clone()),
    )
    .await?;
    let initialized = match initialize_and_authenticate(&transport).await {
        Ok(initialized) => initialized,
        Err(error) => {
            transport.shutdown().await;
            return Err(auth_error_message(error));
        }
    };
    let candidate = ManagedTransport {
        transport: transport.clone(),
        capabilities: initialized.capabilities,
    };

    let existing = {
        let mut runtime = state.inner.lock().await;
        if let Some(existing) = runtime
            .transports
            .get(&key)
            .filter(|existing| existing.transport.is_alive())
        {
            Some(existing.clone())
        } else {
            runtime.transports.remove(&key);
            runtime.transports.insert(key, candidate.clone());
            None
        }
    };
    if let Some(existing) = existing {
        transport.shutdown().await;
        Ok(existing)
    } else {
        Ok(candidate)
    }
}

async fn runtime_session(state: &GrokRuntime, session_id: &str) -> Result<GrokSession, String> {
    let session = state
        .inner
        .lock()
        .await
        .sessions
        .get(session_id)
        .cloned()
        .ok_or_else(|| "That session is not active in Groky.".to_string())?;
    if !session.transport.is_alive() {
        return Err(
            "The connection to Grok Build was closed. Reopen the session to continue.".to_string(),
        );
    }
    Ok(session)
}

async fn forget_rejected_session(state: &GrokRuntime, transport: &AcpTransport, session_id: &str) {
    let collides_with_same_transport = state
        .inner
        .lock()
        .await
        .sessions
        .get(session_id)
        .is_some_and(|session| session.transport.is_same_transport(transport));
    if collides_with_same_transport {
        transport.invalidate().await;
    } else {
        transport.forget_session(session_id).await;
    }
}

#[tauri::command]
async fn grok_list_commands(
    app: AppHandle,
    state: State<'_, GrokRuntime>,
    workspace: Option<String>,
    approval_mode: Option<ApprovalMode>,
) -> Result<Vec<SafeAvailableCommand>, String> {
    let approval_mode = approval_mode.unwrap_or_default();
    let workspace_path = if let Some(workspace) = workspace {
        let path = PathBuf::from(workspace)
            .canonicalize()
            .map_err(|_| "Could not open the selected working directory.".to_string())?;
        if !path.is_dir() {
            return Err("Choose a folder to use as the working directory.".to_string());
        }
        path
    } else {
        env::temp_dir()
    };
    let cwd = workspace_path.to_string_lossy().into_owned();
    let cli = resolve_cli().await?;
    let transport = acquire_transport(&app, &state, &cli, &workspace_path, &cwd, approval_mode)
        .await?
        .transport;

    Ok(transport.command_catalog(Some(&cwd)).await)
}

#[tauri::command]
async fn grok_list_models(
    workspace: Option<String>,
    approval_mode: Option<ApprovalMode>,
) -> Result<Option<SessionModelState>, String> {
    let approval_mode = approval_mode.unwrap_or_default();
    let workspace_path = if let Some(workspace) = workspace {
        let path = PathBuf::from(workspace)
            .canonicalize()
            .map_err(|_| "Could not open the selected working directory.".to_string())?;
        if !path.is_dir() {
            return Err("Choose a folder to use as the working directory.".to_string());
        }
        path
    } else {
        env::temp_dir()
    };
    let cli = resolve_cli().await?;
    let transport = AcpTransport::spawn(&cli.binary, &workspace_path, approval_mode, None).await?;

    let result = async {
        let initialized = initialize_and_authenticate(&transport)
            .await
            .map_err(auth_error_message)?;
        parse_initialize_models(&initialized.response)
    }
    .await;
    transport.shutdown().await;
    result
}

#[tauri::command]
async fn grok_connect(
    app: AppHandle,
    state: State<'_, GrokRuntime>,
    workspace: Option<String>,
    approval_mode: Option<ApprovalMode>,
    model_id: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<ConnectResult, String> {
    let approval_mode = approval_mode.unwrap_or_default();
    let (workspace_path, selected_workspace) = if let Some(workspace) = workspace {
        let workspace_path = PathBuf::from(&workspace)
            .canonicalize()
            .map_err(|_| "Could not open the selected working directory.".to_string())?;
        if !workspace_path.is_dir() {
            return Err("Choose a folder to use as the working directory.".to_string());
        }
        let selected_workspace = workspace_path.to_string_lossy().into_owned();
        (workspace_path, Some(selected_workspace))
    } else {
        let workspace_path = create_managed_workspace(&app).await?;
        (workspace_path, None)
    };
    let cwd = workspace_path.to_string_lossy().into_owned();
    let cli = resolve_cli().await?;
    let managed_transport =
        acquire_transport(&app, &state, &cli, &workspace_path, &cwd, approval_mode).await?;
    let transport = managed_transport.transport;

    let result = transport.new_session(&cwd).await?;
    let Some(session_id) = result.get("sessionId").and_then(Value::as_str) else {
        return Err("Grok Build did not return a session ID.".to_string());
    };
    let session_id = session_id.to_string();
    let mut models = match parse_session_models(&result) {
        Ok(models) => models,
        Err(error) => {
            forget_rejected_session(&state, &transport, &session_id).await;
            return Err(error);
        }
    };
    let initial_model_selection = match resolve_initial_model_selection(
        models.as_ref(),
        model_id.as_deref(),
        reasoning_effort.as_deref(),
    ) {
        Ok(selection) => selection,
        Err(error) => {
            forget_rejected_session(&state, &transport, &session_id).await;
            return Err(error);
        }
    };
    if let Some((selected_model_id, selected_reasoning_effort)) = initial_model_selection {
        let selection_changed = models.as_ref().is_some_and(|models| {
            models.current_model_id != selected_model_id
                || selected_reasoning_effort.as_deref()
                    != model_reasoning_effort(models, &selected_model_id)
        });
        if selection_changed {
            if let Err(error) = transport
                .set_model(
                    &session_id,
                    &selected_model_id,
                    selected_reasoning_effort.as_deref(),
                )
                .await
            {
                forget_rejected_session(&state, &transport, &session_id).await;
                return Err(error);
            }
        }
        if let Some(models) = models.as_mut() {
            record_model_selection(models, selected_model_id, selected_reasoning_effort);
        }
    }
    let available_commands = transport.available_commands(&session_id, Some(&cwd)).await;

    let session = GrokSession {
        transport,
        session_id: session_id.clone(),
        workspace: selected_workspace.clone(),
        working_directory: cwd.clone(),
        cli_version: cli.version.clone(),
        approval_mode,
        models: models.clone(),
        available_commands,
        prompt_active: Arc::new(AtomicBool::new(false)),
    };

    {
        let mut runtime = state.inner.lock().await;
        if runtime.sessions.contains_key(&session_id) {
            drop(runtime);
            forget_rejected_session(&state, &session.transport, &session_id).await;
            return Err("Grok Build returned a session ID that is already active.".to_string());
        }
        runtime.sessions.insert(session_id.clone(), session.clone());
        runtime.active_session_id = Some(session_id.clone());
    }
    {
        let _history = state.history.lock().await;
        if let Err(error) = persist_new_session(&app, &session).await {
            let mut runtime = state.inner.lock().await;
            runtime.sessions.remove(&session_id);
            if runtime.active_session_id.as_ref() == Some(&session_id) {
                runtime.active_session_id = None;
            }
            drop(runtime);
            forget_rejected_session(&state, &session.transport, &session_id).await;
            return Err(error);
        }
    }

    let _ = app.emit(
        "grok://connection",
        ConnectionEvent {
            status: "connected",
            message: None,
            session_ids: vec![session_id.clone()],
        },
    );

    Ok(ConnectResult::from(&session))
}

#[tauri::command]
async fn grok_load_session(
    app: AppHandle,
    state: State<'_, GrokRuntime>,
    session_id: String,
) -> Result<LoadSessionResult, String> {
    let warm_session = {
        let mut runtime = state.inner.lock().await;
        let session = runtime
            .sessions
            .get(&session_id)
            .filter(|session| session.transport.is_alive())
            .cloned();
        if session.is_none() {
            runtime.sessions.remove(&session_id);
        }
        if session.is_some() {
            runtime.active_session_id = Some(session_id.clone());
        }
        session
    };
    if let Some(session) = warm_session {
        let updates = session.transport.session_updates(&session_id).await;
        {
            let _history = state.history.lock().await;
            update_persisted_session_unread(&app, &session_id, false).await?;
        }
        return Ok(LoadSessionResult {
            connection: ConnectResult::from(&session),
            updates,
        });
    }

    let persisted = read_session_history(&app)
        .await?
        .into_iter()
        .find(|session| session.session_id == session_id)
        .ok_or_else(|| "That session is no longer in Groky history.".to_string())?;
    let workspace_path = PathBuf::from(&persisted.working_directory)
        .canonicalize()
        .map_err(|_| {
            "The working directory for that session is no longer available.".to_string()
        })?;
    if !workspace_path.is_dir() {
        return Err("The working directory for that session is no longer available.".to_string());
    }
    let cwd = workspace_path.to_string_lossy().into_owned();
    let cli = resolve_cli().await?;
    let managed_transport = acquire_transport(
        &app,
        &state,
        &cli,
        &workspace_path,
        &cwd,
        persisted.approval_mode,
    )
    .await?;
    if !managed_transport.capabilities.load_session {
        return Err("This Grok Build version cannot reopen saved sessions.".to_string());
    }
    let transport = managed_transport.transport;

    let (result, updates) = transport.load_session(&persisted.session_id, &cwd).await?;
    let models = parse_session_models(&result)?;

    let available_commands = transport
        .available_commands(&persisted.session_id, Some(&cwd))
        .await;
    let session = GrokSession {
        transport,
        session_id: persisted.session_id.clone(),
        workspace: persisted.workspace.clone(),
        working_directory: cwd.clone(),
        cli_version: cli.version.clone(),
        approval_mode: persisted.approval_mode,
        models: models.clone(),
        available_commands,
        prompt_active: Arc::new(AtomicBool::new(false)),
    };
    {
        let _history = state.history.lock().await;
        update_persisted_session_unread(&app, &persisted.session_id, false).await?;
    }
    {
        let mut runtime = state.inner.lock().await;
        runtime
            .sessions
            .insert(persisted.session_id.clone(), session.clone());
        runtime.active_session_id = Some(persisted.session_id.clone());
    }

    let _ = app.emit(
        "grok://connection",
        ConnectionEvent {
            status: "connected",
            message: None,
            session_ids: vec![persisted.session_id.clone()],
        },
    );

    Ok(LoadSessionResult {
        connection: ConnectResult::from(&session),
        updates,
    })
}

#[tauri::command]
async fn grok_deactivate_session(
    state: State<'_, GrokRuntime>,
    session_id: Option<String>,
) -> Result<(), String> {
    let mut runtime = state.inner.lock().await;
    if session_id
        .as_ref()
        .is_none_or(|session_id| runtime.active_session_id.as_ref() == Some(session_id))
    {
        runtime.active_session_id = None;
    }
    Ok(())
}

#[tauri::command]
async fn grok_activate_session(
    app: AppHandle,
    state: State<'_, GrokRuntime>,
    session_id: Option<String>,
) -> Result<(), String> {
    let Some(session_id) = session_id else {
        state.inner.lock().await.active_session_id = None;
        return Ok(());
    };

    let _history = state.history.lock().await;
    state.inner.lock().await.active_session_id = Some(session_id.clone());
    update_persisted_session_unread(&app, &session_id, false).await?;
    Ok(())
}

#[tauri::command]
async fn grok_prompt(
    app: AppHandle,
    state: State<'_, GrokRuntime>,
    session_id: String,
    prompt: String,
    attachment_paths: Vec<String>,
) -> Result<PromptResult, String> {
    let prompt = prompt.trim().to_string();
    let attachments = inspect_attachment_path_strings(attachment_paths).await?;
    if prompt.is_empty() && attachments.is_empty() {
        return Err("Enter a message or attach a file.".to_string());
    }
    let resources = attachment_resource_links(&attachments)?;

    let session = runtime_session(&state, &session_id).await?;

    if session
        .prompt_active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("The previous request is still running.".to_string());
    }

    let persisted = {
        let _history = state.history.lock().await;
        let title_source = if prompt.is_empty() {
            attachments
                .first()
                .map(|attachment| attachment.name.as_str())
        } else {
            Some(prompt.as_str())
        };
        record_persisted_session_activity(&app, &session, title_source).await
    };
    if let Err(error) = persisted {
        session.prompt_active.store(false, Ordering::Release);
        return Err(error);
    }

    let result = session
        .transport
        .prompt(&session.session_id, &prompt, &resources)
        .await;
    let context_report = if result
        .as_ref()
        .is_ok_and(|(_, output)| output.text.trim().is_empty())
        && is_context_slash_command(&prompt)
    {
        Some(session.transport.context_report(&session.session_id).await)
    } else {
        None
    };
    session.prompt_active.store(false, Ordering::Release);
    let _ = persist_prompt_completion_unread(&app, &state, &session_id).await;

    let (result, mut output) = result?;
    if let Some(context_report) = context_report {
        output.text = context_report?;
    }
    Ok(PromptResult {
        stop_reason: normalize_stop_reason(
            result
                .get("stopReason")
                .and_then(Value::as_str)
                .unwrap_or("unknown"),
        ),
        text: output.text,
        thought: output.thought,
    })
}

fn is_context_slash_command(prompt: &str) -> bool {
    prompt
        .strip_prefix('/')
        .and_then(|command| command.split_whitespace().next())
        == Some("context")
}

#[tauri::command]
async fn grok_cancel(state: State<'_, GrokRuntime>, session_id: String) -> Result<(), String> {
    let session = runtime_session(&state, &session_id).await?;
    session.transport.cancel(&session.session_id).await
}

#[tauri::command]
async fn grok_set_approval_mode(
    app: AppHandle,
    state: State<'_, GrokRuntime>,
    session_id: String,
    approval_mode: ApprovalMode,
) -> Result<ConnectResult, String> {
    let session = runtime_session(&state, &session_id).await?;
    if session.approval_mode == approval_mode {
        return Ok(ConnectResult::from(&session));
    }
    if session
        .prompt_active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(
            "Wait for the current request to finish before changing approval mode.".to_string(),
        );
    }
    let _prompt_lock = PromptActivityLock(session.prompt_active.clone());

    session
        .transport
        .set_approval_mode(&session.session_id, approval_mode)
        .await?;

    let update_result: Result<ConnectResult, String> = async {
        let _history = state.history.lock().await;
        let mut sessions = read_session_history(&app).await?;
        if !set_session_approval_mode(&mut sessions, &session.session_id, approval_mode) {
            return Err("That session is no longer in Groky history.".to_string());
        }

        let switched = {
            let mut runtime = state.inner.lock().await;
            match runtime.sessions.get_mut(&session.session_id) {
                Some(current)
                    if current.transport.is_same_transport(&session.transport)
                        && current.approval_mode == session.approval_mode =>
                {
                    current.approval_mode = approval_mode;
                    Some(ConnectResult::from(&*current))
                }
                _ => None,
            }
        };
        let switched = switched
            .ok_or_else(|| "The session changed while selecting approval mode.".to_string())?;

        if let Err(error) = write_session_history(&app, &sessions).await {
            let mut runtime = state.inner.lock().await;
            if let Some(current) = runtime.sessions.get_mut(&session.session_id) {
                if current.transport.is_same_transport(&session.transport)
                    && current.approval_mode == approval_mode
                {
                    current.approval_mode = session.approval_mode;
                }
            }
            return Err(error);
        }

        Ok(switched)
    }
    .await;

    if let Err(error) = update_result.as_ref() {
        if session
            .transport
            .set_approval_mode(&session.session_id, session.approval_mode)
            .await
            .is_err()
        {
            return Err(format!(
                "{error} The previous approval mode could not be restored."
            ));
        }
    }
    update_result
}

#[tauri::command]
async fn grok_set_model(
    state: State<'_, GrokRuntime>,
    session_id: String,
    model_id: String,
) -> Result<SessionModelState, String> {
    let session = runtime_session(&state, &session_id).await?;
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

    let mut runtime = state.inner.lock().await;
    let Some(active_session) = runtime.sessions.get_mut(&session.session_id) else {
        return Err("The Grok Build session closed while selecting a model.".to_string());
    };
    active_session.models = Some(models.clone());

    Ok(models)
}

#[tauri::command]
async fn grok_set_reasoning_effort(
    state: State<'_, GrokRuntime>,
    session_id: String,
    reasoning_effort: String,
) -> Result<SessionModelState, String> {
    let session = runtime_session(&state, &session_id).await?;
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

    let mut runtime = state.inner.lock().await;
    let Some(active_session) = runtime.sessions.get_mut(&session.session_id) else {
        return Err("The Grok Build session closed while selecting reasoning effort.".to_string());
    };
    active_session.models = Some(models.clone());

    Ok(models)
}

#[tauri::command]
async fn grok_respond_permission(
    state: State<'_, GrokRuntime>,
    session_id: String,
    request_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    let session = runtime_session(&state, &session_id).await?;
    session
        .transport
        .respond_permission(&session.session_id, &request_id, option_id.as_deref())
        .await
}

#[derive(Debug)]
enum AuthError {
    NeedsLogin,
    Transport(String),
}

async fn initialize_and_authenticate(
    transport: &AcpTransport,
) -> Result<InitializedAgent, AuthError> {
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
    let capabilities = agent_capabilities(&init);

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
    Ok(InitializedAgent {
        capabilities,
        response: init,
    })
}

fn agent_capabilities(initialize_result: &Value) -> AgentCapabilities {
    AgentCapabilities {
        load_session: initialize_result
            .pointer("/agentCapabilities/loadSession")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn parse_model_state(value: &Value) -> Result<SessionModelState, String> {
    let models = serde_json::from_value::<SessionModelState>(value.clone())
        .map_err(|_| "Grok Build returned invalid model information.".to_string())?;
    let current_model_is_available = models
        .available_models
        .iter()
        .any(|model| model.model_id == models.current_model_id);
    if models.available_models.is_empty() || !current_model_is_available {
        return Err("Grok Build returned invalid model information.".to_string());
    }

    Ok(models)
}

fn parse_session_models(result: &Value) -> Result<Option<SessionModelState>, String> {
    result.get("models").map(parse_model_state).transpose()
}

fn parse_initialize_models(result: &Value) -> Result<Option<SessionModelState>, String> {
    result
        .pointer("/_meta/modelState")
        .map(parse_model_state)
        .transpose()
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

fn resolve_initial_model_selection(
    models: Option<&SessionModelState>,
    requested_model_id: Option<&str>,
    requested_reasoning_effort: Option<&str>,
) -> Result<Option<(String, Option<String>)>, String> {
    if requested_model_id.is_none() && requested_reasoning_effort.is_none() {
        return Ok(None);
    }

    let models = models.ok_or_else(|| {
        "Grok Build did not advertise model selection for this session.".to_string()
    })?;
    let selected_model_id = requested_model_id
        .unwrap_or(&models.current_model_id)
        .to_string();
    if !models
        .available_models
        .iter()
        .any(|model| model.model_id == selected_model_id)
    {
        return Err("The selected model is no longer available in Grok Build.".to_string());
    }

    let selected_reasoning_effort = if let Some(requested_effort) = requested_reasoning_effort {
        let mut selected_models = models.clone();
        selected_models.current_model_id = selected_model_id.clone();
        Some(reasoning_effort_value(&selected_models, requested_effort)?)
    } else {
        None
    };

    Ok(Some((selected_model_id, selected_reasoning_effort)))
}

fn model_reasoning_effort<'a>(models: &'a SessionModelState, model_id: &str) -> Option<&'a str> {
    models
        .available_models
        .iter()
        .find(|model| model.model_id == model_id)
        .and_then(|model| model.metadata.as_ref())
        .and_then(|metadata| metadata.reasoning_effort.as_deref())
}

fn record_model_selection(
    models: &mut SessionModelState,
    model_id: String,
    reasoning_effort: Option<String>,
) {
    models.current_model_id = model_id;
    let Some(reasoning_effort) = reasoning_effort else {
        return;
    };
    if let Some(metadata) = models
        .available_models
        .iter_mut()
        .find(|model| model.model_id == models.current_model_id)
        .and_then(|model| model.metadata.as_mut())
    {
        metadata.reasoning_effort = Some(reasoning_effort);
    }
}

async fn disconnect_runtime(state: &GrokRuntime) {
    let transports = {
        let mut runtime = state.inner.lock().await;
        runtime.sessions.clear();
        runtime.active_session_id = None;
        runtime
            .transports
            .drain()
            .map(|(_, managed)| managed.transport)
            .collect::<Vec<_>>()
    };
    for transport in transports {
        transport.shutdown().await;
    }
}

async fn shutdown_app(app: &AppHandle) {
    disconnect_runtime(&app.state::<GrokRuntime>()).await;
    app.state::<TerminalRuntime>().shutdown();
    app.state::<WorkspaceWatcherRuntime>().shutdown();
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

async fn read_account_profile() -> Option<AccountProfile> {
    let path = home_dir()?.join(".grok").join("auth.json");
    let bytes = tokio::fs::read(path).await.ok()?;
    if bytes.len() > MAX_AUTH_FILE_BYTES {
        return None;
    }
    let auth = serde_json::from_slice::<Value>(&bytes).ok()?;
    account_profile_from_auth(&auth)
}

fn account_profile_from_auth(auth: &Value) -> Option<AccountProfile> {
    auth.as_object()?
        .values()
        .filter_map(account_profile_candidate)
        .max_by_key(|(created_at, _)| *created_at)
        .map(|(_, profile)| profile)
}

fn account_profile_candidate(record: &Value) -> Option<(i64, AccountProfile)> {
    let first_name = account_field(record, &["first_name", "firstName"]);
    let last_name = account_field(record, &["last_name", "lastName"]);
    let explicit_name = account_field(record, &["display_name", "displayName", "name"]);
    let display_name = explicit_name.or_else(|| match (first_name, last_name) {
        (Some(first), Some(last)) => Some(format!("{first} {last}")),
        (Some(first), None) => Some(first),
        (None, Some(last)) => Some(last),
        (None, None) => None,
    });
    let email = account_field(record, &["email"]);
    if display_name.is_none() && email.is_none() {
        return None;
    }

    Some((
        account_record_timestamp(record),
        AccountProfile {
            display_name,
            email,
        },
    ))
}

fn account_field(record: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        let value = record.get(*key)?.as_str()?.trim();
        if value.is_empty()
            || value.chars().count() > MAX_ACCOUNT_FIELD_CHARS
            || value.chars().any(char::is_control)
        {
            return None;
        }
        Some(value.to_string())
    })
}

fn account_record_timestamp(record: &Value) -> i64 {
    let Some(value) = record
        .get("create_time")
        .or_else(|| record.get("createTime"))
    else {
        return 0;
    };
    if let Some(timestamp) = value.as_i64() {
        return timestamp;
    }
    if let Some(timestamp) = value.as_u64() {
        return timestamp.min(i64::MAX as u64) as i64;
    }
    let Some(timestamp) = value.as_str() else {
        return 0;
    };
    timestamp
        .parse::<i64>()
        .ok()
        .or_else(|| {
            DateTime::parse_from_rfc3339(timestamp)
                .ok()
                .map(|date| date.timestamp_millis())
        })
        .unwrap_or(0)
}

fn session_history_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(SESSION_HISTORY_FILE))
        .map_err(|_| "Could not access Groky application data.".to_string())
}

fn workspace_history_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(WORKSPACE_HISTORY_FILE))
        .map_err(|_| "Could not access Groky application data.".to_string())
}

async fn read_session_history(app: &AppHandle) -> Result<Vec<PersistedSession>, String> {
    let path = session_history_path(app)?;
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Could not read Groky session history.".to_string()),
    };
    let mut sessions = serde_json::from_slice::<Vec<PersistedSession>>(&bytes)
        .map_err(|_| "Groky session history is damaged and could not be read.".to_string())?;
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(sessions)
}

async fn write_session_history(
    app: &AppHandle,
    sessions: &[PersistedSession],
) -> Result<(), String> {
    let path = session_history_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Could not prepare Groky session history.".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|_| "Could not prepare Groky session history.".to_string())?;
    let bytes = serde_json::to_vec_pretty(sessions)
        .map_err(|_| "Could not encode Groky session history.".to_string())?;
    let temporary_path = path.with_extension("json.tmp");
    tokio::fs::write(&temporary_path, bytes)
        .await
        .map_err(|_| "Could not save Groky session history.".to_string())?;

    #[cfg(target_os = "windows")]
    match tokio::fs::remove_file(&path).await {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(_) => return Err("Could not replace Groky session history.".to_string()),
    }

    tokio::fs::rename(temporary_path, path)
        .await
        .map_err(|_| "Could not save Groky session history.".to_string())
}

async fn read_workspace_history(app: &AppHandle) -> Result<Vec<PersistedWorkspace>, String> {
    let path = workspace_history_path(app)?;
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Could not read Groky working directories.".to_string()),
    };
    serde_json::from_slice::<Vec<PersistedWorkspace>>(&bytes)
        .map_err(|_| "Groky working directories are damaged and could not be read.".to_string())
}

async fn write_workspace_history(
    app: &AppHandle,
    workspaces: &[PersistedWorkspace],
) -> Result<(), String> {
    let path = workspace_history_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Could not prepare Groky working directories.".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|_| "Could not prepare Groky working directories.".to_string())?;
    let bytes = serde_json::to_vec_pretty(workspaces)
        .map_err(|_| "Could not encode Groky working directories.".to_string())?;
    let temporary_path = path.with_extension("json.tmp");
    tokio::fs::write(&temporary_path, bytes)
        .await
        .map_err(|_| "Could not save Groky working directories.".to_string())?;

    #[cfg(target_os = "windows")]
    match tokio::fs::remove_file(&path).await {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(_) => return Err("Could not replace Groky working directories.".to_string()),
    }

    tokio::fs::rename(temporary_path, path)
        .await
        .map_err(|_| "Could not save Groky working directories.".to_string())
}

fn upsert_workspace_history(
    workspaces: &mut Vec<PersistedWorkspace>,
    workspace: PersistedWorkspace,
) {
    if !workspaces
        .iter()
        .any(|existing| existing.path == workspace.path)
    {
        workspaces.push(workspace);
        workspaces.sort_by(|left, right| left.created_at.cmp(&right.created_at));
    }
}

fn remove_workspace_history(workspaces: &mut Vec<PersistedWorkspace>, path: &str) -> bool {
    let original_len = workspaces.len();
    workspaces.retain(|workspace| workspace.path != path);
    workspaces.len() != original_len
}

async fn persist_workspace(app: &AppHandle, path: &str) -> Result<(), String> {
    let mut workspaces = read_workspace_history(app).await?;
    upsert_workspace_history(
        &mut workspaces,
        PersistedWorkspace {
            path: path.to_string(),
            created_at: Local::now().timestamp_millis(),
        },
    );
    write_workspace_history(app, &workspaces).await
}

fn upsert_session_history(sessions: &mut Vec<PersistedSession>, session: PersistedSession) {
    if let Some(existing) = sessions
        .iter_mut()
        .find(|existing| existing.session_id == session.session_id)
    {
        *existing = session;
    } else {
        sessions.push(session);
    }
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
}

fn set_session_unread(sessions: &mut [PersistedSession], session_id: &str, unread: bool) -> bool {
    let Some(session) = sessions
        .iter_mut()
        .find(|session| session.session_id == session_id)
    else {
        return false;
    };
    if session.unread == unread {
        return false;
    }
    session.unread = unread;
    true
}

fn set_session_approval_mode(
    sessions: &mut [PersistedSession],
    session_id: &str,
    approval_mode: ApprovalMode,
) -> bool {
    let Some(session) = sessions
        .iter_mut()
        .find(|session| session.session_id == session_id)
    else {
        return false;
    };
    session.approval_mode = approval_mode;
    true
}

async fn update_persisted_session_unread(
    app: &AppHandle,
    session_id: &str,
    unread: bool,
) -> Result<(), String> {
    let mut sessions = read_session_history(app).await?;
    if set_session_unread(&mut sessions, session_id, unread) {
        write_session_history(app, &sessions).await?;
    }
    Ok(())
}

async fn persist_prompt_completion_unread(
    app: &AppHandle,
    state: &GrokRuntime,
    session_id: &str,
) -> Result<(), String> {
    let _history = state.history.lock().await;
    let unread = state.inner.lock().await.active_session_id.as_deref() != Some(session_id);
    update_persisted_session_unread(app, session_id, unread).await
}

struct PromptActivityLock(Arc<AtomicBool>);

impl Drop for PromptActivityLock {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn session_matches_history_target(
    session: &PersistedSession,
    session_id: Option<&str>,
    workspace: Option<&str>,
) -> bool {
    session_id.is_some_and(|id| session.session_id == id)
        || workspace.is_some_and(|path| session.workspace.as_deref() == Some(path))
}

fn rename_session_title(
    sessions: &mut [PersistedSession],
    session_id: &str,
    title: String,
) -> Option<SessionSummary> {
    let session = sessions
        .iter_mut()
        .find(|session| session.session_id == session_id)?;
    session.title = title;
    Some(SessionSummary::from(&*session))
}

fn apply_session_history_action(
    sessions: &mut Vec<PersistedSession>,
    action: SessionHistoryAction,
    session_id: Option<&str>,
    workspace: Option<&str>,
) {
    match action {
        SessionHistoryAction::Archive => sessions
            .iter_mut()
            .filter(|session| session_matches_history_target(session, session_id, workspace))
            .for_each(|session| session.archived = true),
        SessionHistoryAction::Restore => sessions
            .iter_mut()
            .filter(|session| session_matches_history_target(session, session_id, workspace))
            .for_each(|session| session.archived = false),
        SessionHistoryAction::Delete => sessions
            .retain(|session| !session_matches_history_target(session, session_id, workspace)),
    }
}

fn title_from_prompt(prompt: &str) -> String {
    let normalized = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut characters = normalized.chars();
    let title = characters
        .by_ref()
        .take(MAX_SESSION_TITLE_CHARS)
        .collect::<String>();
    if title.is_empty() {
        DEFAULT_SESSION_TITLE.to_string()
    } else if characters.next().is_some() {
        format!(
            "{}…",
            title
                .chars()
                .take(MAX_SESSION_TITLE_CHARS - 1)
                .collect::<String>()
        )
    } else {
        title
    }
}

fn normalize_session_title(title: &str) -> Result<String, String> {
    let normalized = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return Err("Enter a session name.".to_string());
    }
    if normalized.chars().count() > MAX_SESSION_TITLE_CHARS {
        return Err(format!(
            "Session names can be up to {MAX_SESSION_TITLE_CHARS} characters."
        ));
    }
    Ok(normalized)
}

async fn persist_new_session(app: &AppHandle, session: &GrokSession) -> Result<(), String> {
    let now = Local::now().timestamp_millis();
    let mut sessions = read_session_history(app).await?;
    upsert_session_history(
        &mut sessions,
        PersistedSession {
            session_id: session.session_id.clone(),
            title: DEFAULT_SESSION_TITLE.to_string(),
            workspace: session.workspace.clone(),
            working_directory: session.working_directory.clone(),
            approval_mode: session.approval_mode,
            created_at: now,
            updated_at: now,
            archived: false,
            unread: false,
        },
    );
    write_session_history(app, &sessions).await?;
    if let Some(workspace) = session.workspace.as_deref() {
        persist_workspace(app, workspace).await?;
    }
    Ok(())
}

async fn record_persisted_session_activity(
    app: &AppHandle,
    session: &GrokSession,
    first_prompt: Option<&str>,
) -> Result<(), String> {
    let now = Local::now().timestamp_millis();
    let mut sessions = read_session_history(app).await?;
    let existing = sessions
        .iter()
        .find(|persisted| persisted.session_id == session.session_id);
    let title = match (
        existing.map(|persisted| persisted.title.as_str()),
        first_prompt,
    ) {
        (Some(DEFAULT_SESSION_TITLE), Some(prompt)) | (None, Some(prompt)) => {
            title_from_prompt(prompt)
        }
        (Some(title), _) => title.to_string(),
        (None, None) => DEFAULT_SESSION_TITLE.to_string(),
    };
    let created_at = existing
        .map(|persisted| persisted.created_at)
        .unwrap_or(now);
    let archived = existing
        .map(|persisted| persisted.archived)
        .unwrap_or(false);
    upsert_session_history(
        &mut sessions,
        PersistedSession {
            session_id: session.session_id.clone(),
            title,
            workspace: session.workspace.clone(),
            working_directory: session.working_directory.clone(),
            approval_mode: session.approval_mode,
            created_at,
            updated_at: now,
            archived,
            unread: false,
        },
    );
    write_session_history(app, &sessions).await
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
        "session-{}-{millis:03}-{sequence:04x}",
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(GrokRuntime::default())
        .manage(AppUpdateRuntime::default())
        .manage(TerminalRuntime::default())
        .manage(WorkspaceWatcherRuntime::default())
        .invoke_handler(tauri::generate_handler![
            configure_native_titlebar,
            check_app_update,
            install_app_update,
            grok_status,
            grok_login,
            grok_logout,
            choose_workspace,
            choose_attachments,
            inspect_attachments,
            open_grok_install_guide,
            grok_list_sessions,
            grok_rename_session,
            grok_list_workspaces,
            grok_add_workspace,
            grok_remove_workspace,
            grok_mutate_sessions,
            grok_list_commands,
            grok_list_models,
            grok_connect,
            grok_load_session,
            grok_activate_session,
            grok_deactivate_session,
            grok_prompt,
            grok_cancel,
            grok_set_approval_mode,
            grok_set_model,
            grok_set_reasoning_effort,
            grok_respond_permission,
            workspace_list_directory,
            workspace_inspect_attachment,
            workspace_open_folder,
            workspace_preview_file,
            workspace_watch,
            workspace_unwatch,
            terminal_start,
            terminal_write,
            terminal_resize,
            terminal_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            tauri::async_runtime::block_on(shutdown_app(app));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        account_profile_from_auth, agent_capabilities, apply_session_history_action,
        attachment_resource_links, extract_device_auth_code, inspect_attachment_paths,
        is_context_slash_command, managed_workspace_name, normalize_session_title,
        parse_initialize_models, parse_session_models, reasoning_effort_value,
        remove_workspace_history, rename_session_title, set_session_approval_mode,
        set_session_unread, title_from_prompt, upsert_session_history, upsert_workspace_history,
        ApprovalMode, PersistedSession, PersistedWorkspace, SessionHistoryAction,
        DEFAULT_SESSION_TITLE, MAX_SESSION_TITLE_CHARS,
    };
    use super::{record_model_selection, resolve_initial_model_selection};
    use chrono::{Local, TimeZone};
    use serde_json::json;

    #[test]
    fn recognizes_only_the_context_slash_command() {
        assert!(is_context_slash_command("/context"));
        assert!(is_context_slash_command("/context   "));
        assert!(is_context_slash_command("/context　"));
        assert!(is_context_slash_command("/context details"));
        assert!(!is_context_slash_command("context"));
        assert!(!is_context_slash_command("/contextual"));
        assert!(!is_context_slash_command("/Context"));
    }

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
    fn extracts_only_safe_fields_from_the_latest_grok_account() {
        let profile = account_profile_from_auth(&json!({
            "https://auth.x.ai::older": {
                "create_time": 100,
                "first_name": "Old",
                "email": "old@example.com"
            },
            "https://auth.x.ai::current": {
                "create_time": 200,
                "first_name": " Grace ",
                "last_name": " Hopper ",
                "email": "grace@example.com",
                "key": "must-not-cross-the-tauri-boundary",
                "refresh_token": "must-not-cross-the-tauri-boundary"
            }
        }))
        .expect("the latest account should provide a profile");

        assert_eq!(profile.display_name.as_deref(), Some("Grace Hopper"));
        assert_eq!(profile.email.as_deref(), Some("grace@example.com"));
        assert_eq!(
            serde_json::to_value(profile).expect("profile should serialize"),
            json!({
                "displayName": "Grace Hopper",
                "email": "grace@example.com"
            })
        );
    }

    #[test]
    fn creates_a_private_session_directory_name_without_prompt_text() {
        let now = Local
            .with_ymd_and_hms(2026, 7, 17, 9, 8, 7)
            .single()
            .expect("valid local date");
        let name = managed_workspace_name(&now, 0x2a);

        assert!(name.starts_with("session-090807-"));
        assert!(name.ends_with("-002a"));
    }

    #[test]
    fn creates_a_compact_title_from_the_first_prompt() {
        assert_eq!(
            title_from_prompt("  Review\n\nthis   change  "),
            "Review this change"
        );
        let title = title_from_prompt(&"a".repeat(MAX_SESSION_TITLE_CHARS + 4));
        assert_eq!(title.chars().count(), MAX_SESSION_TITLE_CHARS);
        assert!(title.ends_with('…'));
        assert_eq!(title_from_prompt(" \n "), DEFAULT_SESSION_TITLE);
    }

    #[test]
    fn inspects_files_and_builds_percent_encoded_resource_links() {
        let directory = std::env::temp_dir().join(format!(
            "groky-attachment-test-{}-{}",
            std::process::id(),
            Local::now().timestamp_micros()
        ));
        std::fs::create_dir_all(&directory).expect("temporary directory should be created");
        let path = directory.join("design brief.md");
        std::fs::write(&path, "Review me").expect("temporary attachment should be written");

        let attachments =
            inspect_attachment_paths(vec![path]).expect("a regular local file should be accepted");
        let resources = attachment_resource_links(&attachments)
            .expect("an accepted local file should have a file URL");

        assert_eq!(attachments[0].name, "design brief.md");
        assert_eq!(attachments[0].size, 9);
        assert_eq!(attachments[0].mime_type.as_deref(), Some("text/markdown"));
        assert!(resources[0].uri.ends_with("/design%20brief.md"));
        assert!(inspect_attachment_paths(vec![directory.clone()]).is_err());

        std::fs::remove_dir_all(directory).expect("temporary directory should be removed");
    }

    #[test]
    fn validates_and_normalizes_session_names() {
        assert_eq!(
            normalize_session_title("  Release\n\nplanning  ").as_deref(),
            Ok("Release planning")
        );
        assert_eq!(
            normalize_session_title(" \n ").unwrap_err(),
            "Enter a session name."
        );
        assert!(normalize_session_title(&"a".repeat(MAX_SESSION_TITLE_CHARS + 1)).is_err());
    }

    #[test]
    fn renames_only_the_requested_session_without_reordering_activity() {
        let session = |session_id: &str, title: &str, updated_at: i64| PersistedSession {
            session_id: session_id.to_string(),
            title: title.to_string(),
            workspace: Some("/workspace".to_string()),
            working_directory: "/workspace".to_string(),
            approval_mode: ApprovalMode::Ask,
            created_at: 1,
            updated_at,
            archived: false,
            unread: false,
        };
        let mut sessions = vec![
            session("first", "First", 20),
            session("second", "Second", 10),
        ];

        let renamed = rename_session_title(&mut sessions, "second", "Release plan".to_string())
            .expect("session should be renamed");

        assert_eq!(renamed.title, "Release plan");
        assert_eq!(renamed.updated_at, 10);
        assert_eq!(sessions[0].session_id, "first");
        assert_eq!(sessions[1].title, "Release plan");
    }

    #[test]
    fn session_history_replaces_duplicates_and_sorts_by_recent_activity() {
        let session = |session_id: &str, title: &str, updated_at: i64| PersistedSession {
            session_id: session_id.to_string(),
            title: title.to_string(),
            workspace: Some("/workspace".to_string()),
            working_directory: "/workspace".to_string(),
            approval_mode: ApprovalMode::Ask,
            created_at: 1,
            updated_at,
            archived: false,
            unread: false,
        };
        let mut sessions = vec![session("older", "Older", 10)];
        upsert_session_history(&mut sessions, session("newer", "Newer", 20));
        upsert_session_history(&mut sessions, session("older", "Updated", 30));

        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].session_id, "older");
        assert_eq!(sessions[0].title, "Updated");
        assert_eq!(sessions[1].session_id, "newer");
    }

    #[test]
    fn legacy_session_history_defaults_status_flags() {
        let session: PersistedSession = serde_json::from_value(json!({
            "sessionId": "legacy",
            "title": "Legacy session",
            "workspace": "/workspace",
            "workingDirectory": "/workspace",
            "approvalMode": "ask",
            "createdAt": 10,
            "updatedAt": 20
        }))
        .expect("legacy session history should remain readable");

        assert!(!session.archived);
        assert!(!session.unread);
    }

    #[test]
    fn approval_mode_changes_without_reordering_session_history() {
        let mut sessions = vec![PersistedSession {
            session_id: "session-1".to_string(),
            title: "Existing session".to_string(),
            workspace: Some("/workspace".to_string()),
            working_directory: "/workspace".to_string(),
            approval_mode: ApprovalMode::Ask,
            created_at: 10,
            updated_at: 20,
            archived: false,
            unread: true,
        }];

        assert!(set_session_approval_mode(
            &mut sessions,
            "session-1",
            ApprovalMode::AlwaysApprove,
        ));
        assert_eq!(sessions[0].approval_mode, ApprovalMode::AlwaysApprove);
        assert_eq!(sessions[0].updated_at, 20);
        assert!(sessions[0].unread);
        assert!(!set_session_approval_mode(
            &mut sessions,
            "missing",
            ApprovalMode::Ask,
        ));
    }

    #[test]
    fn unread_status_changes_without_reordering_activity() {
        let mut sessions = vec![
            PersistedSession {
                session_id: "newer".to_string(),
                title: "Newer".to_string(),
                workspace: Some("/workspace".to_string()),
                working_directory: "/workspace".to_string(),
                approval_mode: ApprovalMode::Ask,
                created_at: 1,
                updated_at: 20,
                archived: false,
                unread: false,
            },
            PersistedSession {
                session_id: "older".to_string(),
                title: "Older".to_string(),
                workspace: Some("/workspace".to_string()),
                working_directory: "/workspace".to_string(),
                approval_mode: ApprovalMode::Ask,
                created_at: 1,
                updated_at: 10,
                archived: false,
                unread: false,
            },
        ];

        assert!(set_session_unread(&mut sessions, "older", true));
        assert!(sessions[1].unread);
        assert_eq!(sessions[1].updated_at, 10);
        assert_eq!(sessions[0].session_id, "newer");
        assert!(!set_session_unread(&mut sessions, "older", true));
    }

    #[test]
    fn session_history_actions_support_one_session_or_a_working_directory() {
        let session = |session_id: &str, workspace: Option<&str>| PersistedSession {
            session_id: session_id.to_string(),
            title: session_id.to_string(),
            workspace: workspace.map(str::to_string),
            working_directory: workspace.unwrap_or("/standalone").to_string(),
            approval_mode: ApprovalMode::Ask,
            created_at: 1,
            updated_at: 1,
            archived: false,
            unread: false,
        };
        let mut sessions = vec![
            session("first", Some("/workspace")),
            session("second", Some("/workspace")),
            session("standalone", None),
        ];

        apply_session_history_action(
            &mut sessions,
            SessionHistoryAction::Archive,
            None,
            Some("/workspace"),
        );
        assert!(sessions[0].archived);
        assert!(sessions[1].archived);
        assert!(!sessions[2].archived);

        apply_session_history_action(
            &mut sessions,
            SessionHistoryAction::Restore,
            Some("first"),
            None,
        );
        assert!(!sessions[0].archived);
        assert!(sessions[1].archived);

        apply_session_history_action(
            &mut sessions,
            SessionHistoryAction::Delete,
            None,
            Some("/workspace"),
        );
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "standalone");
    }

    #[test]
    fn working_directory_history_keeps_unique_paths_in_added_order() {
        let mut workspaces = vec![PersistedWorkspace {
            path: "/workspace/first".to_string(),
            created_at: 10,
        }];
        upsert_workspace_history(
            &mut workspaces,
            PersistedWorkspace {
                path: "/workspace/second".to_string(),
                created_at: 20,
            },
        );
        upsert_workspace_history(
            &mut workspaces,
            PersistedWorkspace {
                path: "/workspace/first".to_string(),
                created_at: 30,
            },
        );

        assert_eq!(workspaces.len(), 2);
        assert_eq!(workspaces[0].path, "/workspace/first");
        assert_eq!(workspaces[1].path, "/workspace/second");
    }

    #[test]
    fn working_directory_history_removes_only_the_selected_path() {
        let mut workspaces = vec![
            PersistedWorkspace {
                path: "/workspace/first".to_string(),
                created_at: 10,
            },
            PersistedWorkspace {
                path: "/workspace/second".to_string(),
                created_at: 20,
            },
        ];

        assert!(remove_workspace_history(
            &mut workspaces,
            "/workspace/first"
        ));
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].path, "/workspace/second");
        assert!(!remove_workspace_history(
            &mut workspaces,
            "/workspace/missing"
        ));
    }

    #[test]
    fn reads_session_loading_support_from_agent_capabilities() {
        let capabilities = agent_capabilities(&json!({
            "agentCapabilities": { "loadSession": true }
        }));
        assert!(capabilities.load_session);

        let capabilities = agent_capabilities(&json!({ "agentCapabilities": {} }));
        assert!(!capabilities.load_session);
    }

    #[test]
    fn parses_models_advertised_before_session_creation() {
        let models = parse_initialize_models(&json!({
            "_meta": {
                "modelState": {
                    "currentModelId": "grok-4.5",
                    "availableModels": [{
                        "modelId": "grok-4.5",
                        "name": "Grok 4.5"
                    }]
                }
            }
        }))
        .expect("valid initialization model state")
        .expect("model selection should be present");

        assert_eq!(models.current_model_id, "grok-4.5");
        assert_eq!(models.available_models[0].name, "Grok 4.5");
    }

    #[test]
    fn parses_models_advertised_by_the_grok_build_session() {
        let mut models = parse_session_models(&json!({
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

        let selection =
            resolve_initial_model_selection(Some(&models), Some("grok-4.5"), Some("medium"))
                .expect("advertised initial selection")
                .expect("requested initial selection");
        assert_eq!(
            selection,
            ("grok-4.5".to_string(), Some("medium".to_string()))
        );
        record_model_selection(&mut models, selection.0, selection.1);
        assert_eq!(
            models.available_models[0]
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.reasoning_effort.as_deref()),
            Some("medium")
        );
        assert!(resolve_initial_model_selection(Some(&models), Some("missing"), None,).is_err());
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
