use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
    time::timeout,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const MAX_SESSION_ID_CHARS: usize = 256;
const MAX_TOOL_CALL_ID_CHARS: usize = 256;
const MAX_PERMISSION_OPTION_ID_CHARS: usize = 160;

type PendingResponse = oneshot::Sender<Result<Value, String>>;
type PendingResponses = HashMap<u64, PendingResponse>;
type SessionTurnOutputs = HashMap<String, TurnOutput>;
type SessionUpdates = HashMap<String, Vec<SessionUpdateEvent>>;

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalMode {
    #[default]
    Ask,
    AlwaysApprove,
}

impl ApprovalMode {
    fn agent_args(self) -> Vec<&'static str> {
        let mut args = vec!["--no-auto-update", "--no-memory", "--permission-mode"];

        match self {
            Self::Ask => args.extend(["default", "agent", "stdio"]),
            Self::AlwaysApprove => args.extend(["bypassPermissions", "agent", "stdio"]),
        }

        args
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionUpdateEvent {
    session_id: String,
    #[serde(flatten)]
    update: SessionUpdatePayload,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum SessionUpdatePayload {
    UserMessageChunk {
        text: String,
        attachments: Vec<SafeAttachment>,
    },
    AgentMessageChunk {
        text: String,
    },
    AgentThoughtChunk {
        text: String,
    },
    ToolCall {
        tool_call_id: String,
        title: String,
        tool_kind: Option<String>,
        status: Option<String>,
        locations: Vec<SafeToolLocation>,
    },
    ToolCallUpdate {
        tool_call_id: String,
        title: Option<String>,
        tool_kind: Option<String>,
        status: Option<String>,
        locations: Option<Vec<SafeToolLocation>>,
    },
    Plan {
        entries: Vec<SafePlanEntry>,
    },
    AvailableCommandsUpdate {
        available_commands: Vec<SafeAvailableCommand>,
    },
    CurrentModeUpdate {
        current_mode_id: String,
    },
    ConfigOptionUpdate {
        config_options: Vec<SafeConfigOption>,
    },
    SessionInfoUpdate {
        title: Option<String>,
        updated_at: Option<String>,
    },
    UsageUpdate {
        used: u64,
        size: u64,
        cost: Option<SafeCost>,
    },
    TurnCompleted {
        stop_reason: String,
        metrics: Option<TurnMetrics>,
    },
    PermissionRequested {
        request_id: String,
        tool_call_id: String,
        title: String,
        tool_kind: Option<String>,
        options: Vec<PermissionOptionEvent>,
    },
    PermissionDecision {
        request_id: String,
        tool_call_id: String,
        title: String,
        label: String,
        outcome: String,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SafeToolLocation {
    path: String,
    line: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SafeAttachment {
    name: String,
    size: i64,
    mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SafePlanEntry {
    content: String,
    status: String,
    priority: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SafeAvailableCommand {
    name: String,
    description: String,
    input_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SafeConfigOption {
    id: String,
    name: String,
    description: Option<String>,
    category: Option<String>,
    value: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SafeCost {
    amount: f64,
    currency: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct TurnMetrics {
    total_tokens: Option<u64>,
    output_tokens: Option<u64>,
    reasoning_tokens: Option<u64>,
    model_calls: Option<u64>,
    api_duration_ms: Option<u64>,
}

impl SessionUpdateEvent {
    fn new(session_id: impl Into<String>, update: SessionUpdatePayload) -> Self {
        Self {
            session_id: session_id.into(),
            update,
        }
    }

    fn session_id(&self) -> &str {
        &self.session_id
    }

    fn is_user_message(&self) -> bool {
        matches!(self.update, SessionUpdatePayload::UserMessageChunk { .. })
    }
}

#[derive(Debug)]
enum InboundFrame {
    Response {
        id: u64,
        response: Result<Value, String>,
    },
    Notification {
        method: String,
        params: Value,
    },
    Request {
        id: Value,
        method: String,
        params: Value,
    },
}

#[derive(Debug, Clone)]
struct PendingPermission {
    request_id: String,
    rpc_id: Value,
    session_id: String,
    tool_call_id: String,
    title: String,
    options: Vec<PermissionOptionEvent>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PermissionOptionEvent {
    option_id: String,
    name: String,
    kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionRequestEvent {
    request_id: String,
    session_id: String,
    tool_call_id: String,
    title: String,
    tool_kind: Option<String>,
    options: Vec<PermissionOptionEvent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionEvent {
    status: &'static str,
    message: Option<&'static str>,
    session_ids: Vec<String>,
}

#[derive(Clone)]
pub struct AcpTransport {
    writer: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    pending: Arc<Mutex<PendingResponses>>,
    permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    turn_outputs: Arc<Mutex<SessionTurnOutputs>>,
    session_updates: Arc<Mutex<SessionUpdates>>,
    owned_sessions: Arc<Mutex<HashSet<String>>>,
    event_sink: Option<AppHandle>,
    shutdown_requested: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    next_id: Arc<AtomicU64>,
}

#[derive(Debug, Default, Clone)]
pub struct TurnOutput {
    pub text: String,
    pub thought: String,
}

#[derive(Debug, Clone)]
pub struct PromptResourceLink {
    pub uri: String,
    pub name: String,
    pub mime_type: Option<String>,
    pub size: i64,
}

fn resource_link_content(resource: &PromptResourceLink) -> Value {
    let mut content = json!({
        "type": "resource_link",
        "uri": resource.uri,
        "name": resource.name,
        "size": resource.size,
    });
    if let Some(mime_type) = resource.mime_type.as_ref() {
        content["mimeType"] = Value::String(mime_type.clone());
    }
    content
}

fn prompt_params(session_id: &str, prompt: &str, resources: &[PromptResourceLink]) -> Value {
    let mut content = Vec::with_capacity(resources.len() + usize::from(!prompt.is_empty()));
    if !prompt.is_empty() {
        content.push(json!({ "type": "text", "text": prompt }));
    }
    content.extend(resources.iter().map(resource_link_content));

    json!({
        "sessionId": session_id,
        "prompt": content,
    })
}

impl AcpTransport {
    pub async fn spawn(
        binary: &Path,
        cwd: &Path,
        approval_mode: ApprovalMode,
        event_sink: Option<AppHandle>,
    ) -> Result<Self, String> {
        let mut child = Command::new(binary)
            .args(approval_mode.agent_args())
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| "Failed to start Grok Build ACP.".to_string())?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to open the Grok Build ACP input stream.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to open the Grok Build ACP output stream.".to_string())?;

        let writer = Arc::new(Mutex::new(stdin));
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let permissions = Arc::new(Mutex::new(HashMap::new()));
        let turn_outputs = Arc::new(Mutex::new(HashMap::new()));
        let session_updates = Arc::new(Mutex::new(HashMap::new()));
        let owned_sessions = Arc::new(Mutex::new(HashSet::new()));
        let shutdown_requested = Arc::new(AtomicBool::new(false));
        let alive = Arc::new(AtomicBool::new(true));
        let permission_counter = Arc::new(AtomicU64::new(1));

        spawn_reader(
            stdout,
            writer.clone(),
            pending.clone(),
            permissions.clone(),
            turn_outputs.clone(),
            session_updates.clone(),
            owned_sessions.clone(),
            shutdown_requested.clone(),
            alive.clone(),
            permission_counter,
            event_sink.clone(),
        );

        Ok(Self {
            writer,
            child: Arc::new(Mutex::new(child)),
            pending,
            permissions,
            turn_outputs,
            session_updates,
            owned_sessions,
            event_sink,
            shutdown_requested,
            alive,
            next_id: Arc::new(AtomicU64::new(1)),
        })
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request_with_timeout(method, params, REQUEST_TIMEOUT)
            .await
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub fn is_same_transport(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.writer, &other.writer)
    }

    pub async fn new_session(&self, cwd: &str) -> Result<Value, String> {
        let response = self
            .request("session/new", json!({ "cwd": cwd, "mcpServers": [] }))
            .await?;
        let session_id = response
            .get("sessionId")
            .and_then(|value| bounded_identifier(value, MAX_SESSION_ID_CHARS))
            .ok_or_else(|| "Grok Build did not return a session ID.".to_string())?;
        self.register_session(&session_id).await;
        Ok(response)
    }

    async fn register_session(&self, session_id: &str) {
        self.owned_sessions
            .lock()
            .await
            .insert(session_id.to_string());
        self.session_updates
            .lock()
            .await
            .entry(session_id.to_string())
            .or_default();
    }

    pub async fn forget_session(&self, session_id: &str) {
        self.owned_sessions.lock().await.remove(session_id);
        self.session_updates.lock().await.remove(session_id);
        self.turn_outputs.lock().await.remove(session_id);
        let abandoned_permissions = {
            let mut permissions = self.permissions.lock().await;
            take_session_permissions(&mut permissions, session_id)
        };
        for permission in abandoned_permissions {
            let _ = write_permission_response(&self.writer, permission.rpc_id, None).await;
        }
    }

    pub async fn prompt(
        &self,
        session_id: &str,
        prompt: &str,
        resources: &[PromptResourceLink],
    ) -> Result<(Value, TurnOutput), String> {
        self.register_session(session_id).await;
        self.turn_outputs
            .lock()
            .await
            .insert(session_id.to_string(), TurnOutput::default());
        self.session_updates
            .lock()
            .await
            .entry(session_id.to_string())
            .or_default()
            .push(SessionUpdateEvent::new(
                session_id,
                SessionUpdatePayload::UserMessageChunk {
                    text: prompt.to_string(),
                    attachments: resources
                        .iter()
                        .map(|resource| SafeAttachment {
                            name: resource.name.clone(),
                            size: resource.size,
                            mime_type: resource.mime_type.clone(),
                        })
                        .collect(),
                },
            ));
        let response = self
            .request_with_timeout(
                "session/prompt",
                prompt_params(session_id, prompt, resources),
                PROMPT_TIMEOUT,
            )
            .await;
        let output = self
            .turn_outputs
            .lock()
            .await
            .remove(session_id)
            .unwrap_or_default();
        if let Ok(response) = response.as_ref() {
            let stop_reason = normalize_stop_reason(
                response
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown"),
            );
            capture_session_update(
                &mut *self.session_updates.lock().await,
                &SessionUpdateEvent::new(
                    session_id,
                    SessionUpdatePayload::TurnCompleted {
                        stop_reason,
                        metrics: None,
                    },
                ),
            );
        }
        response.map(|response| (response, output))
    }

    pub async fn load_session(
        &self,
        session_id: &str,
        cwd: &str,
    ) -> Result<(Value, Vec<SessionUpdateEvent>), String> {
        self.owned_sessions
            .lock()
            .await
            .insert(session_id.to_string());
        self.session_updates
            .lock()
            .await
            .insert(session_id.to_string(), Vec::new());
        let response = self
            .request("session/load", load_session_params(session_id, cwd))
            .await;
        match response {
            Ok(response) => {
                let updates = self.session_updates(session_id).await;
                Ok((response, updates))
            }
            Err(error) => {
                self.forget_session(session_id).await;
                Err(error)
            }
        }
    }

    pub async fn session_updates(&self, session_id: &str) -> Vec<SessionUpdateEvent> {
        self.session_updates
            .lock()
            .await
            .get(session_id)
            .cloned()
            .unwrap_or_default()
    }

    async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        duration: Duration,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);

        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        if let Err(error) = write_message(&self.writer, &message).await {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }

        match timeout(duration, receiver).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => Err("The connection to Grok Build was closed.".to_string()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err("Timed out waiting for a response from Grok Build.".to_string())
            }
        }
    }

    pub async fn cancel(&self, session_id: &str) -> Result<(), String> {
        write_message(&self.writer, &cancel_notification(session_id)).await?;

        let cancelled = {
            let mut permissions = self.permissions.lock().await;
            take_session_permissions(&mut permissions, session_id)
        };

        for permission in cancelled {
            let decision = permission_decision_update(&permission, None);
            write_permission_response(&self.writer, permission.rpc_id, None).await?;
            self.record_session_update(decision).await;
        }

        Ok(())
    }

    pub async fn set_model(
        &self,
        session_id: &str,
        model_id: &str,
        reasoning_effort: Option<&str>,
    ) -> Result<(), String> {
        let response = self
            .request(
                "session/set_model",
                set_model_params(session_id, model_id, reasoning_effort),
            )
            .await?;
        validate_set_model_response(&response, model_id)
    }

    pub async fn respond_permission(
        &self,
        session_id: &str,
        request_id: &str,
        option_id: Option<&str>,
    ) -> Result<(), String> {
        let (permission, selected) = {
            let mut permissions = self.permissions.lock().await;
            take_session_permission(&mut permissions, session_id, request_id, option_id)?
        };

        let decision = permission_decision_update(&permission, selected.as_ref());
        write_permission_response(&self.writer, permission.rpc_id, option_id).await?;
        self.record_session_update(decision).await;
        Ok(())
    }

    async fn record_session_update(&self, update: SessionUpdateEvent) {
        capture_session_update(&mut *self.session_updates.lock().await, &update);
        if let Some(app) = self.event_sink.as_ref() {
            let _ = app.emit("grok://session-update", update);
        }
    }

    pub async fn shutdown(&self) {
        self.shutdown_requested.store(true, Ordering::Release);
        self.alive.store(false, Ordering::Release);
        let _ = self.child.lock().await.kill().await;
    }

    pub async fn invalidate(&self) {
        self.alive.store(false, Ordering::Release);
        let _ = self.child.lock().await.kill().await;
    }
}

fn spawn_reader(
    stdout: tokio::process::ChildStdout,
    writer: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<PendingResponses>>,
    permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    turn_outputs: Arc<Mutex<SessionTurnOutputs>>,
    session_updates: Arc<Mutex<SessionUpdates>>,
    owned_sessions: Arc<Mutex<HashSet<String>>>,
    shutdown_requested: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    permission_counter: Arc<AtomicU64>,
    event_sink: Option<AppHandle>,
) {
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();

        loop {
            let line = match lines.next_line().await {
                Ok(Some(line)) => line,
                Ok(None) | Err(_) => break,
            };

            let frame = match decode_frame(&line) {
                Ok(frame) => frame,
                Err(_) => break,
            };

            match frame {
                InboundFrame::Response { id, response } => {
                    route_response(&mut *pending.lock().await, id, response);
                }
                InboundFrame::Notification { method, params } => {
                    let update = match method.as_str() {
                        "session/update" => sanitize_session_update(&params),
                        "_x.ai/session/update" => sanitize_grok_session_update(&params),
                        _ => None,
                    };
                    if let Some(update) = update {
                        if !owned_sessions.lock().await.contains(update.session_id()) {
                            continue;
                        }
                        let suppress_user_echo = update.is_user_message()
                            && turn_outputs.lock().await.contains_key(update.session_id());
                        capture_session_turn_output(&mut *turn_outputs.lock().await, &update);
                        if !suppress_user_echo {
                            capture_session_update(&mut *session_updates.lock().await, &update);
                        }
                        if let Some(app) = event_sink.as_ref() {
                            let _ = app.emit("grok://session-update", update);
                        }
                    }
                }
                InboundFrame::Request { id, method, params } => {
                    if method == "session/request_permission" {
                        let owned_session = if let Some(session_id) =
                            params.get("sessionId").and_then(Value::as_str)
                        {
                            owned_sessions.lock().await.contains(session_id)
                        } else {
                            false
                        };
                        if !owned_session {
                            let _ = write_permission_response(&writer, id, None).await;
                            continue;
                        }
                        let known_tool_call = if let (Some(session_id), Some(tool_call_id)) = (
                            params
                                .get("sessionId")
                                .and_then(|value| bounded_identifier(value, MAX_SESSION_ID_CHARS)),
                            params.pointer("/toolCall/toolCallId").and_then(|value| {
                                bounded_identifier(value, MAX_TOOL_CALL_ID_CHARS)
                            }),
                        ) {
                            let prompt_active = turn_outputs.lock().await.contains_key(&session_id);
                            prompt_active
                                && session_updates.lock().await.get(&session_id).is_some_and(
                                    |updates| has_active_tool_call(updates, &tool_call_id),
                                )
                        } else {
                            false
                        };
                        if !known_tool_call {
                            let _ = write_permission_response(&writer, id, None).await;
                            continue;
                        }
                        if let Some(request) = sanitize_permission_request(
                            id.clone(),
                            &params,
                            &permissions,
                            &permission_counter,
                        )
                        .await
                        {
                            let request_id = request.request_id.clone();
                            let requested_update = permission_requested_update(&request);
                            capture_session_update(
                                &mut *session_updates.lock().await,
                                &requested_update,
                            );
                            if let Some(app) = event_sink.as_ref() {
                                if app.emit("grok://permission-request", request).is_ok() {
                                    continue;
                                }
                            }

                            if let Some(permission) = permissions.lock().await.remove(&request_id) {
                                let decision = permission_decision_update(&permission, None);
                                capture_session_update(
                                    &mut *session_updates.lock().await,
                                    &decision,
                                );
                                if let Some(app) = event_sink.as_ref() {
                                    let _ = app.emit("grok://session-update", decision);
                                }
                            }
                        }

                        let _ = write_permission_response(&writer, id, None).await;
                    } else {
                        let response = json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {
                                "code": -32601,
                                "message": "Method not supported by Groky"
                            }
                        });
                        let _ = write_message(&writer, &response).await;
                    }
                }
            }
        }

        let waiting = {
            let mut pending = pending.lock().await;
            pending
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>()
        };
        for sender in waiting {
            let _ = sender.send(Err("The connection to Grok Build was closed.".to_string()));
        }

        let abandoned_permissions = {
            let mut permissions = permissions.lock().await;
            permissions
                .drain()
                .map(|(_, permission)| permission)
                .collect::<Vec<_>>()
        };
        for permission in abandoned_permissions {
            let decision = permission_decision_update(&permission, None);
            capture_session_update(&mut *session_updates.lock().await, &decision);
            if let Some(app) = event_sink.as_ref() {
                let _ = app.emit("grok://session-update", decision);
            }
        }

        alive.store(false, Ordering::Release);

        if !shutdown_requested.load(Ordering::Acquire) {
            if let Some(app) = event_sink {
                let session_ids = owned_sessions.lock().await.iter().cloned().collect();
                let _ = app.emit(
                    "grok://connection",
                    ConnectionEvent {
                        status: "disconnected",
                        message: Some("The connection to Grok Build was closed."),
                        session_ids,
                    },
                );
            }
        }
    });
}

async fn write_message(writer: &Arc<Mutex<ChildStdin>>, message: &Value) -> Result<(), String> {
    let mut bytes =
        serde_json::to_vec(message).map_err(|_| "Failed to create the ACP message.".to_string())?;
    bytes.push(b'\n');

    let mut writer = writer.lock().await;
    writer
        .write_all(&bytes)
        .await
        .map_err(|_| "Failed to send a message to Grok Build.".to_string())?;
    writer
        .flush()
        .await
        .map_err(|_| "Failed to send a message to Grok Build.".to_string())
}

async fn write_permission_response(
    writer: &Arc<Mutex<ChildStdin>>,
    rpc_id: Value,
    option_id: Option<&str>,
) -> Result<(), String> {
    let outcome = match option_id {
        Some(option_id) => json!({ "outcome": "selected", "optionId": option_id }),
        None => json!({ "outcome": "cancelled" }),
    };
    write_message(
        writer,
        &json!({ "jsonrpc": "2.0", "id": rpc_id, "result": { "outcome": outcome } }),
    )
    .await
}

fn decode_frame(line: &str) -> Result<InboundFrame, String> {
    let value: Value = serde_json::from_str(line).map_err(|_| "invalid JSON".to_string())?;
    let object = value
        .as_object()
        .ok_or_else(|| "ACP frame must be an object".to_string())?;

    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err("unsupported JSON-RPC version".to_string());
    }

    if let Some(method) = object.get("method").and_then(Value::as_str) {
        let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
        return match object.get("id") {
            Some(id) => Ok(InboundFrame::Request {
                id: id.clone(),
                method: method.to_string(),
                params,
            }),
            None => Ok(InboundFrame::Notification {
                method: method.to_string(),
                params,
            }),
        };
    }

    let id = object
        .get("id")
        .and_then(Value::as_u64)
        .ok_or_else(|| "response is missing a numeric id".to_string())?;

    let response = if object.get("error").is_some() {
        Err("Grok Build returned an ACP error.".to_string())
    } else if let Some(result) = object.get("result") {
        Ok(result.clone())
    } else {
        return Err("response is missing result or error".to_string());
    };

    Ok(InboundFrame::Response { id, response })
}

fn route_response(
    pending: &mut PendingResponses,
    id: u64,
    response: Result<Value, String>,
) -> bool {
    let Some(sender) = pending.remove(&id) else {
        return false;
    };
    let _ = sender.send(response);
    true
}

fn cancel_notification(session_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "session/cancel",
        "params": { "sessionId": session_id }
    })
}

fn take_session_permissions(
    permissions: &mut HashMap<String, PendingPermission>,
    session_id: &str,
) -> Vec<PendingPermission> {
    let tokens = permissions
        .iter()
        .filter_map(|(token, pending)| (pending.session_id == session_id).then_some(token.clone()))
        .collect::<Vec<_>>();
    tokens
        .into_iter()
        .filter_map(|token| permissions.remove(&token))
        .collect()
}

fn take_session_permission(
    permissions: &mut HashMap<String, PendingPermission>,
    session_id: &str,
    request_id: &str,
    option_id: Option<&str>,
) -> Result<(PendingPermission, Option<PermissionOptionEvent>), String> {
    let pending = permissions
        .get(request_id)
        .ok_or_else(|| "This permission request has already been resolved.".to_string())?;
    if pending.session_id != session_id {
        return Err("That permission request belongs to another session.".to_string());
    }
    let selected = match option_id {
        Some(option_id) => Some(
            pending
                .options
                .iter()
                .find(|option| option.option_id == option_id)
                .cloned()
                .ok_or_else(|| {
                    "Choose an option offered for this permission request.".to_string()
                })?,
        ),
        None => None,
    };
    let permission = permissions
        .remove(request_id)
        .ok_or_else(|| "This permission request has already been resolved.".to_string())?;
    Ok((permission, selected))
}

fn permission_requested_update(request: &PermissionRequestEvent) -> SessionUpdateEvent {
    SessionUpdateEvent::new(
        &request.session_id,
        SessionUpdatePayload::PermissionRequested {
            request_id: request.request_id.clone(),
            tool_call_id: request.tool_call_id.clone(),
            title: request.title.clone(),
            tool_kind: request.tool_kind.clone(),
            options: request.options.clone(),
        },
    )
}

fn permission_decision_update(
    permission: &PendingPermission,
    selected: Option<&PermissionOptionEvent>,
) -> SessionUpdateEvent {
    let (label, outcome) = match selected {
        Some(option) if option.kind.starts_with("reject") => {
            (option.name.clone(), "rejected".to_string())
        }
        Some(option) => (option.name.clone(), "allowed".to_string()),
        None => ("Dismissed".to_string(), "dismissed".to_string()),
    };
    SessionUpdateEvent::new(
        &permission.session_id,
        SessionUpdatePayload::PermissionDecision {
            request_id: permission.request_id.clone(),
            tool_call_id: permission.tool_call_id.clone(),
            title: permission.title.clone(),
            label,
            outcome,
        },
    )
}

fn load_session_params(session_id: &str, cwd: &str) -> Value {
    json!({ "sessionId": session_id, "cwd": cwd, "mcpServers": [] })
}

fn set_model_params(session_id: &str, model_id: &str, reasoning_effort: Option<&str>) -> Value {
    let mut params = json!({ "sessionId": session_id, "modelId": model_id });
    if let Some(reasoning_effort) = reasoning_effort {
        params["_meta"] = json!({ "reasoningEffort": reasoning_effort });
    }
    params
}

fn validate_set_model_response(response: &Value, requested_model_id: &str) -> Result<(), String> {
    let model_result = response.pointer("/_meta/model");
    if model_result.and_then(|result| result.get("Err")).is_some() {
        return Err("Grok Build could not switch to that model.".to_string());
    }
    if let Some(selected_model_id) = model_result
        .and_then(|result| result.get("Ok"))
        .and_then(Value::as_str)
    {
        if selected_model_id != requested_model_id {
            return Err("Grok Build selected a different model than requested.".to_string());
        }
    }

    Ok(())
}

async fn sanitize_permission_request(
    rpc_id: Value,
    params: &Value,
    permissions: &Arc<Mutex<HashMap<String, PendingPermission>>>,
    counter: &Arc<AtomicU64>,
) -> Option<PermissionRequestEvent> {
    let session_id = bounded_identifier(params.get("sessionId")?, MAX_SESSION_ID_CHARS)?;
    let tool_call = params.get("toolCall")?;
    let tool_call_id = bounded_identifier(tool_call.get("toolCallId")?, MAX_TOOL_CALL_ID_CHARS)?;
    let title = limited_optional_string(tool_call.get("title"), 240)
        .unwrap_or_else(|| "Grok Build is requesting permission to perform an action".to_string());
    let tool_kind = safe_tool_kind(tool_call.get("kind"));
    let raw_options = params.get("options").and_then(Value::as_array)?;
    if raw_options.is_empty() || raw_options.len() > 16 {
        return None;
    }
    let mut option_ids = HashSet::new();
    let mut options = Vec::with_capacity(raw_options.len());
    for option in raw_options {
        let kind = option.get("kind")?.as_str()?;
        if !matches!(
            kind,
            "allow_once" | "allow_always" | "reject_once" | "reject_always"
        ) {
            return None;
        }
        let option_id =
            bounded_identifier(option.get("optionId")?, MAX_PERMISSION_OPTION_ID_CHARS)?;
        if !option_ids.insert(option_id.clone()) {
            return None;
        }
        options.push(PermissionOptionEvent {
            option_id,
            name: limited_required_string(option.get("name")?, 120)?,
            kind: kind.to_string(),
        });
    }

    let request_id = format!("permission-{}", counter.fetch_add(1, Ordering::Relaxed));
    permissions.lock().await.insert(
        request_id.clone(),
        PendingPermission {
            request_id: request_id.clone(),
            rpc_id,
            session_id: session_id.clone(),
            tool_call_id: tool_call_id.clone(),
            title: title.clone(),
            options: options.clone(),
        },
    );

    Some(PermissionRequestEvent {
        request_id,
        session_id,
        tool_call_id,
        title,
        tool_kind,
        options,
    })
}

fn sanitize_session_update(params: &Value) -> Option<SessionUpdateEvent> {
    let session_id = bounded_identifier(params.get("sessionId")?, MAX_SESSION_ID_CHARS)?;
    let update = params.get("update")?;
    let update_kind = update.get("sessionUpdate")?.as_str()?;

    let payload = match update_kind {
        "user_message_chunk" => SessionUpdatePayload::UserMessageChunk {
            text: content_text(update),
            attachments: update
                .get("content")
                .and_then(safe_resource_attachment)
                .into_iter()
                .collect(),
        },
        "agent_message_chunk" => SessionUpdatePayload::AgentMessageChunk {
            text: content_text(update),
        },
        "agent_thought_chunk" => SessionUpdatePayload::AgentThoughtChunk {
            text: content_text(update),
        },
        "tool_call" => SessionUpdatePayload::ToolCall {
            tool_call_id: bounded_identifier(update.get("toolCallId")?, MAX_TOOL_CALL_ID_CHARS)?,
            title: limited_required_string(update.get("title")?, 240)?,
            tool_kind: safe_tool_kind(update.get("kind")),
            status: safe_tool_status(update.get("status")),
            locations: safe_tool_locations(update.get("locations")),
        },
        "tool_call_update" => SessionUpdatePayload::ToolCallUpdate {
            tool_call_id: bounded_identifier(update.get("toolCallId")?, MAX_TOOL_CALL_ID_CHARS)?,
            title: limited_optional_string(update.get("title"), 240),
            tool_kind: safe_tool_kind(update.get("kind")),
            status: safe_tool_status(update.get("status")),
            locations: update
                .get("locations")
                .and_then(Value::as_array)
                .map(|_| safe_tool_locations(update.get("locations"))),
        },
        "plan" => SessionUpdatePayload::Plan {
            entries: update
                .get("entries")
                .and_then(Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(|entry| {
                            Some(SafePlanEntry {
                                content: limited_required_string(entry.get("content")?, 500)?,
                                status: safe_plan_status(entry.get("status")),
                                priority: safe_plan_priority(entry.get("priority")),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default(),
        },
        "available_commands_update" => SessionUpdatePayload::AvailableCommandsUpdate {
            available_commands: update
                .get("availableCommands")
                .and_then(Value::as_array)
                .map(|commands| {
                    commands
                        .iter()
                        .filter_map(|command| {
                            Some(SafeAvailableCommand {
                                name: limited_required_string(command.get("name")?, 120)?,
                                description: limited_required_string(
                                    command.get("description")?,
                                    500,
                                )?,
                                input_hint: limited_optional_string(
                                    command.get("input").and_then(|input| input.get("hint")),
                                    240,
                                ),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default(),
        },
        "current_mode_update" => SessionUpdatePayload::CurrentModeUpdate {
            current_mode_id: limited_required_string(update.get("currentModeId")?, 120)?,
        },
        "config_option_update" => SessionUpdatePayload::ConfigOptionUpdate {
            config_options: update
                .get("configOptions")
                .and_then(Value::as_array)
                .map(|options| options.iter().filter_map(safe_config_option).collect())
                .unwrap_or_default(),
        },
        "session_info_update" => SessionUpdatePayload::SessionInfoUpdate {
            title: limited_optional_string(update.get("title"), 500),
            updated_at: limited_optional_string(update.get("updatedAt"), 80),
        },
        "usage_update" => SessionUpdatePayload::UsageUpdate {
            used: update.get("used")?.as_u64()?,
            size: update.get("size")?.as_u64()?,
            cost: safe_cost(update.get("cost")),
        },
        _ => return None,
    };

    Some(SessionUpdateEvent::new(&session_id, payload))
}

fn sanitize_grok_session_update(params: &Value) -> Option<SessionUpdateEvent> {
    let session_id = bounded_identifier(params.get("sessionId")?, MAX_SESSION_ID_CHARS)?;
    let update = params.get("update").unwrap_or(params);
    let update_kind = update
        .get("sessionUpdate")
        .or_else(|| update.get("type"))
        .or_else(|| update.get("kind"))
        .and_then(Value::as_str)?;
    if update_kind != "turn_completed" {
        return None;
    }

    let metrics_source = update
        .get("metrics")
        .or_else(|| update.get("usage"))
        .unwrap_or(update);
    let metrics = TurnMetrics {
        total_tokens: metric_u64(metrics_source, "totalTokens", "total_tokens"),
        output_tokens: metric_u64(metrics_source, "outputTokens", "output_tokens"),
        reasoning_tokens: metric_u64(metrics_source, "reasoningTokens", "reasoning_tokens"),
        model_calls: metric_u64(metrics_source, "modelCalls", "model_calls"),
        api_duration_ms: metric_u64(metrics_source, "apiDurationMs", "api_duration_ms"),
    };
    let metrics = [
        metrics.total_tokens,
        metrics.output_tokens,
        metrics.reasoning_tokens,
        metrics.model_calls,
        metrics.api_duration_ms,
    ]
    .iter()
    .any(Option::is_some)
    .then_some(metrics);
    let stop_reason = update
        .get("stopReason")
        .or_else(|| update.get("stop_reason"))
        .and_then(Value::as_str)
        .map(normalize_stop_reason)
        .unwrap_or_else(|| "unknown".to_string());

    Some(SessionUpdateEvent::new(
        &session_id,
        SessionUpdatePayload::TurnCompleted {
            stop_reason,
            metrics,
        },
    ))
}

fn content_text(update: &Value) -> String {
    update
        .get("content")
        .and_then(|content| content.get("text"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn safe_resource_attachment(content: &Value) -> Option<SafeAttachment> {
    if content.get("type").and_then(Value::as_str) != Some("resource_link") {
        return None;
    }

    Some(SafeAttachment {
        name: limited_required_string(content.get("name")?, 255)?,
        size: content
            .get("size")
            .and_then(Value::as_i64)
            .unwrap_or_default()
            .max(0),
        mime_type: limited_optional_string(content.get("mimeType"), 160),
    })
}

fn limited_required_string(value: &Value, max_chars: usize) -> Option<String> {
    let text = value.as_str()?;
    if text.is_empty() {
        return None;
    }
    Some(text.chars().take(max_chars).collect())
}

fn bounded_identifier(value: &Value, max_chars: usize) -> Option<String> {
    let text = value.as_str()?;
    let length = text.chars().count();
    if length == 0 || length > max_chars {
        return None;
    }
    Some(text.to_string())
}

fn limited_optional_string(value: Option<&Value>, max_chars: usize) -> Option<String> {
    value.and_then(|value| limited_required_string(value, max_chars))
}

fn safe_tool_kind(value: Option<&Value>) -> Option<String> {
    match value.and_then(Value::as_str) {
        Some(
            value @ ("read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch"
            | "switch_mode" | "other"),
        ) => Some(value.to_string()),
        Some(_) => Some("other".to_string()),
        None => None,
    }
}

fn safe_tool_status(value: Option<&Value>) -> Option<String> {
    match value.and_then(Value::as_str) {
        Some(value @ ("pending" | "in_progress" | "completed" | "failed" | "cancelled")) => {
            Some(value.to_string())
        }
        _ => None,
    }
}

fn safe_tool_locations(value: Option<&Value>) -> Vec<SafeToolLocation> {
    value
        .and_then(Value::as_array)
        .map(|locations| {
            locations
                .iter()
                .filter_map(|location| {
                    Some(SafeToolLocation {
                        path: limited_required_string(location.get("path")?, 1024)?,
                        line: location.get("line").and_then(Value::as_u64),
                    })
                })
                .take(100)
                .collect()
        })
        .unwrap_or_default()
}

fn safe_plan_status(value: Option<&Value>) -> String {
    match value.and_then(Value::as_str) {
        Some(value @ ("pending" | "in_progress" | "completed")) => value.to_string(),
        _ => "pending".to_string(),
    }
}

fn safe_plan_priority(value: Option<&Value>) -> Option<String> {
    match value.and_then(Value::as_str) {
        Some(value @ ("low" | "medium" | "high")) => Some(value.to_string()),
        _ => None,
    }
}

fn safe_config_option(option: &Value) -> Option<SafeConfigOption> {
    let id = limited_required_string(option.get("id")?, 120)?;
    let name = limited_required_string(option.get("name")?, 240)?;
    let sensitive = looks_sensitive(&id) || looks_sensitive(&name);
    let value = (!sensitive)
        .then(|| option.get("currentValue").and_then(Value::as_bool))
        .flatten();
    Some(SafeConfigOption {
        id,
        name,
        description: limited_optional_string(option.get("description"), 500),
        category: limited_optional_string(option.get("category"), 120),
        value,
    })
}

fn looks_sensitive(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "credential",
        "api key",
        "api_key",
        "auth",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

fn safe_cost(value: Option<&Value>) -> Option<SafeCost> {
    let cost = value?;
    let amount = cost.get("amount")?.as_f64()?;
    if !amount.is_finite() || amount < 0.0 {
        return None;
    }
    let currency = limited_required_string(cost.get("currency")?, 8)?.to_ascii_uppercase();
    Some(SafeCost { amount, currency })
}

fn metric_u64(value: &Value, camel_case: &str, snake_case: &str) -> Option<u64> {
    value
        .get(camel_case)
        .or_else(|| value.get(snake_case))
        .and_then(Value::as_u64)
}

pub(crate) fn normalize_stop_reason(value: &str) -> String {
    match value {
        "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" => {
            value.to_string()
        }
        _ => "unknown".to_string(),
    }
}

fn capture_turn_output(output: &mut TurnOutput, update: &SessionUpdateEvent) {
    match &update.update {
        SessionUpdatePayload::AgentMessageChunk { text } => output.text.push_str(text),
        SessionUpdatePayload::AgentThoughtChunk { text } => output.thought.push_str(text),
        _ => {}
    }
}

fn capture_session_turn_output(outputs: &mut SessionTurnOutputs, update: &SessionUpdateEvent) {
    let Some(output) = outputs.get_mut(update.session_id()) else {
        return;
    };
    capture_turn_output(output, update);
}

fn has_active_tool_call(updates: &[SessionUpdateEvent], tool_call_id: &str) -> bool {
    let current_turn_start = updates
        .iter()
        .rposition(|update| {
            matches!(
                update.update,
                SessionUpdatePayload::UserMessageChunk { .. }
                    | SessionUpdatePayload::TurnCompleted { .. }
            )
        })
        .map_or(0, |index| index + 1);
    let mut seen = false;
    let mut status = None;
    for update in &updates[current_turn_start..] {
        match &update.update {
            SessionUpdatePayload::ToolCall {
                tool_call_id: known_id,
                status: next_status,
                ..
            } if known_id == tool_call_id => {
                seen = true;
                status = next_status.as_deref();
            }
            SessionUpdatePayload::ToolCallUpdate {
                tool_call_id: known_id,
                status: Some(next_status),
                ..
            } if seen && known_id == tool_call_id => status = Some(next_status),
            _ => {}
        }
    }
    seen && !matches!(status, Some("completed" | "failed" | "cancelled"))
}

fn capture_session_update(updates: &mut SessionUpdates, update: &SessionUpdateEvent) {
    let session_updates = updates.entry(update.session_id().to_string()).or_default();
    if let (
        SessionUpdatePayload::TurnCompleted {
            stop_reason,
            metrics,
        },
        Some(SessionUpdateEvent {
            update:
                SessionUpdatePayload::TurnCompleted {
                    stop_reason: existing_stop_reason,
                    metrics: existing_metrics,
                },
            ..
        }),
    ) = (&update.update, session_updates.last_mut())
    {
        if stop_reason != "unknown" {
            *existing_stop_reason = stop_reason.clone();
        }
        if metrics.is_some() {
            *existing_metrics = metrics.clone();
        }
        return;
    }
    session_updates.push(update.clone());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_modes_build_explicit_session_arguments() {
        assert_eq!(
            ApprovalMode::Ask.agent_args(),
            [
                "--no-auto-update",
                "--no-memory",
                "--permission-mode",
                "default",
                "agent",
                "stdio"
            ]
        );
        assert_eq!(
            ApprovalMode::AlwaysApprove.agent_args(),
            [
                "--no-auto-update",
                "--no-memory",
                "--permission-mode",
                "bypassPermissions",
                "agent",
                "stdio"
            ]
        );
        assert_eq!(
            serde_json::to_value(ApprovalMode::AlwaysApprove).unwrap(),
            json!("alwaysApprove")
        );
    }

    #[test]
    fn decodes_json_rpc_notification_framing() {
        let frame = decode_frame(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1"}}"#,
        )
        .expect("notification should decode");

        match frame {
            InboundFrame::Notification { method, params } => {
                assert_eq!(method, "session/update");
                assert_eq!(params["sessionId"], "s1");
            }
            _ => panic!("expected notification"),
        }
    }

    #[tokio::test]
    async fn correlates_concurrent_responses_to_the_matching_requests() {
        let (first_sender, first_receiver) = oneshot::channel();
        let (second_sender, second_receiver) = oneshot::channel();
        let mut pending = PendingResponses::new();
        pending.insert(7, first_sender);
        pending.insert(8, second_sender);

        assert!(route_response(
            &mut pending,
            8,
            Ok(json!({ "sessionId": "second" }))
        ));
        assert!(route_response(
            &mut pending,
            7,
            Ok(json!({ "sessionId": "first" }))
        ));
        assert_eq!(first_receiver.await.unwrap().unwrap()["sessionId"], "first");
        assert_eq!(
            second_receiver.await.unwrap().unwrap()["sessionId"],
            "second"
        );
        assert!(!route_response(&mut pending, 9, Ok(json!({}))));
        assert!(pending.is_empty());
    }

    #[tokio::test]
    async fn preserves_agent_permission_choices_for_the_client() {
        let permissions = Arc::new(Mutex::new(HashMap::new()));
        let counter = Arc::new(AtomicU64::new(1));
        let event = sanitize_permission_request(
            json!(42),
            &json!({
                "sessionId": "session-1",
                "toolCall": { "toolCallId": "tool-1", "title": "Run cargo test", "kind": "execute" },
                "options": [
                    { "optionId": "once", "name": "Allow once", "kind": "allow_once" },
                    { "optionId": "always", "name": "Always allow cargo test", "kind": "allow_always" },
                    { "optionId": "reject", "name": "Reject", "kind": "reject_once" }
                ]
            }),
            &permissions,
            &counter,
        )
        .await
        .expect("valid permission request should be exposed to the client");

        assert_eq!(event.options.len(), 3);
        assert_eq!(event.tool_call_id, "tool-1");
        assert_eq!(event.options[0].kind, "allow_once");
        assert_eq!(event.options[1].kind, "allow_always");
        assert_eq!(event.options[2].kind, "reject_once");
        assert_eq!(permissions.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn rejects_permission_requests_without_a_tool_or_known_choices() {
        let permissions = Arc::new(Mutex::new(HashMap::new()));
        let counter = Arc::new(AtomicU64::new(1));

        let missing_tool_id = sanitize_permission_request(
            json!(42),
            &json!({
                "sessionId": "session-1",
                "toolCall": { "title": "Run cargo test", "kind": "execute" },
                "options": [{ "optionId": "once", "name": "Allow once", "kind": "allow_once" }]
            }),
            &permissions,
            &counter,
        )
        .await;
        let unknown_choice = sanitize_permission_request(
            json!(43),
            &json!({
                "sessionId": "session-1",
                "toolCall": { "toolCallId": "tool-1", "title": "Run cargo test", "kind": "execute" },
                "options": [{ "optionId": "mystery", "name": "Maybe", "kind": "unknown" }]
            }),
            &permissions,
            &counter,
        )
        .await;
        let duplicate_choice = sanitize_permission_request(
            json!(44),
            &json!({
                "sessionId": "session-1",
                "toolCall": { "toolCallId": "tool-1", "title": "Run cargo test", "kind": "execute" },
                "options": [
                    { "optionId": "same", "name": "Allow once", "kind": "allow_once" },
                    { "optionId": "same", "name": "Reject", "kind": "reject_once" }
                ]
            }),
            &permissions,
            &counter,
        )
        .await;

        assert!(missing_tool_id.is_none());
        assert!(unknown_choice.is_none());
        assert!(duplicate_choice.is_none());
        assert!(permissions.lock().await.is_empty());
    }

    #[test]
    fn cancellation_uses_a_session_scoped_notification() {
        assert_eq!(
            cancel_notification("session-42"),
            json!({
                "jsonrpc": "2.0",
                "method": "session/cancel",
                "params": { "sessionId": "session-42" }
            })
        );
    }

    #[test]
    fn permission_requests_match_a_known_tool_call() {
        let mut updates = vec![SessionUpdateEvent::new(
            "session-1",
            SessionUpdatePayload::ToolCall {
                tool_call_id: "tool-1".to_string(),
                title: "Run tests".to_string(),
                tool_kind: Some("execute".to_string()),
                status: Some("pending".to_string()),
                locations: Vec::new(),
            },
        )];

        assert!(has_active_tool_call(&updates, "tool-1"));
        assert!(!has_active_tool_call(&updates, "tool-2"));

        updates.push(SessionUpdateEvent::new(
            "session-1",
            SessionUpdatePayload::ToolCallUpdate {
                tool_call_id: "tool-1".to_string(),
                title: None,
                tool_kind: None,
                status: Some("completed".to_string()),
                locations: None,
            },
        ));
        assert!(!has_active_tool_call(&updates, "tool-1"));

        updates.push(SessionUpdateEvent::new(
            "session-1",
            SessionUpdatePayload::UserMessageChunk {
                text: "Next turn".to_string(),
                attachments: Vec::new(),
            },
        ));
        assert!(!has_active_tool_call(&updates, "tool-1"));
    }

    #[test]
    fn correlation_identifiers_are_rejected_instead_of_truncated() {
        let oversized = "x".repeat(MAX_TOOL_CALL_ID_CHARS + 1);
        assert_eq!(
            bounded_identifier(&json!("tool-1"), MAX_TOOL_CALL_ID_CHARS),
            Some("tool-1".to_string())
        );
        assert!(bounded_identifier(&json!(""), MAX_TOOL_CALL_ID_CHARS).is_none());
        assert!(bounded_identifier(&json!(oversized), MAX_TOOL_CALL_ID_CHARS).is_none());
    }

    #[test]
    fn prompt_includes_text_and_attached_resource_links() {
        let resources = vec![PromptResourceLink {
            uri: "file:///workspace/design%20brief.pdf".to_string(),
            name: "design brief.pdf".to_string(),
            mime_type: Some("application/pdf".to_string()),
            size: 4096,
        }];

        assert_eq!(
            prompt_params("session-42", "Review this", &resources),
            json!({
                "sessionId": "session-42",
                "prompt": [
                    { "type": "text", "text": "Review this" },
                    {
                        "type": "resource_link",
                        "uri": "file:///workspace/design%20brief.pdf",
                        "name": "design brief.pdf",
                        "mimeType": "application/pdf",
                        "size": 4096
                    }
                ]
            })
        );
    }

    #[test]
    fn prompt_allows_an_attachment_without_text() {
        let resources = vec![PromptResourceLink {
            uri: "file:///workspace/screenshot.png".to_string(),
            name: "screenshot.png".to_string(),
            mime_type: Some("image/png".to_string()),
            size: 512,
        }];

        let params = prompt_params("session-42", "", &resources);
        assert_eq!(params["prompt"].as_array().map(Vec::len), Some(1));
        assert_eq!(params["prompt"][0]["type"], "resource_link");
    }

    #[test]
    fn cancellation_only_removes_permissions_for_the_target_session() {
        let mut permissions = HashMap::from([
            (
                "first".to_string(),
                PendingPermission {
                    request_id: "first".to_string(),
                    rpc_id: json!(1),
                    session_id: "session-1".to_string(),
                    tool_call_id: "tool-1".to_string(),
                    title: "First request".to_string(),
                    options: Vec::new(),
                },
            ),
            (
                "second".to_string(),
                PendingPermission {
                    request_id: "second".to_string(),
                    rpc_id: json!(2),
                    session_id: "session-2".to_string(),
                    tool_call_id: "tool-2".to_string(),
                    title: "Second request".to_string(),
                    options: Vec::new(),
                },
            ),
        ]);

        let cancelled = take_session_permissions(&mut permissions, "session-1");

        assert_eq!(cancelled.len(), 1);
        assert_eq!(cancelled[0].session_id, "session-1");
        assert_eq!(permissions.len(), 1);
        assert_eq!(permissions["second"].session_id, "session-2");
    }

    #[test]
    fn permission_responses_are_correlated_to_their_session() {
        let mut permissions = HashMap::from([(
            "request-1".to_string(),
            PendingPermission {
                request_id: "request-1".to_string(),
                rpc_id: json!(7),
                session_id: "session-1".to_string(),
                tool_call_id: "tool-1".to_string(),
                title: "Run tests".to_string(),
                options: vec![PermissionOptionEvent {
                    option_id: "once".to_string(),
                    name: "Allow once".to_string(),
                    kind: "allow_once".to_string(),
                }],
            },
        )]);

        assert!(
            take_session_permission(&mut permissions, "session-2", "request-1", Some("once"))
                .is_err()
        );
        assert!(permissions.contains_key("request-1"));
        assert!(take_session_permission(
            &mut permissions,
            "session-1",
            "request-1",
            Some("unoffered")
        )
        .is_err());
        assert!(permissions.contains_key("request-1"));
        let (selected, option) =
            take_session_permission(&mut permissions, "session-1", "request-1", Some("once"))
                .expect("the matching session can resolve its request");
        assert_eq!(selected.rpc_id, json!(7));
        assert_eq!(
            option.map(|option| option.option_id),
            Some("once".to_string())
        );
        assert!(permissions.is_empty());
    }

    #[test]
    fn loading_a_session_includes_its_workspace_and_empty_mcp_servers() {
        assert_eq!(
            load_session_params("session-42", "/workspace/project"),
            json!({
                "sessionId": "session-42",
                "cwd": "/workspace/project",
                "mcpServers": []
            })
        );
    }

    #[test]
    fn validates_grok_build_model_selection_metadata() {
        assert!(validate_set_model_response(
            &json!({ "_meta": { "model": { "Ok": "grok-4.5" } } }),
            "grok-4.5"
        )
        .is_ok());
        assert!(validate_set_model_response(
            &json!({ "_meta": { "model": { "Err": "incompatible" } } }),
            "grok-4.5"
        )
        .is_err());
        assert!(validate_set_model_response(&json!({}), "grok-4.5").is_ok());
    }

    #[test]
    fn sends_reasoning_effort_through_grok_build_model_metadata() {
        assert_eq!(
            set_model_params("session-1", "grok-4.5", Some("medium")),
            json!({
                "sessionId": "session-1",
                "modelId": "grok-4.5",
                "_meta": { "reasoningEffort": "medium" }
            })
        );
        assert_eq!(
            set_model_params("session-1", "grok-4.5", None),
            json!({ "sessionId": "session-1", "modelId": "grok-4.5" })
        );
    }

    #[test]
    fn rejects_malformed_messages_without_panicking() {
        assert!(decode_frame("not-json").is_err());
        assert!(decode_frame(r#"{"jsonrpc":"1.0","id":1,"result":{}}"#).is_err());
        assert!(decode_frame(r#"{"jsonrpc":"2.0","result":{}}"#).is_err());
        assert!(decode_frame(r#"{"jsonrpc":"2.0","id":1}"#).is_err());
    }

    #[test]
    fn replaces_agent_error_details_with_a_fixed_safe_message() {
        let frame = decode_frame(
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"secret output"}}"#,
        )
        .expect("a valid error response should still be correlated");

        match frame {
            InboundFrame::Response { response, .. } => {
                let error = response.expect_err("the response is an error");
                assert_eq!(error, "Grok Build returned an ACP error.");
                assert!(!error.contains("secret output"));
            }
            _ => panic!("expected an ACP response"),
        }
    }

    #[test]
    fn sanitizes_and_captures_agent_message_chunks() {
        let update = sanitize_session_update(&json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "hello" }
            }
        }))
        .expect("agent chunk should be visible to the UI");
        let mut output = TurnOutput::default();
        capture_turn_output(&mut output, &update);
        let serialized = serde_json::to_value(&update).unwrap();

        assert_eq!(serialized["kind"], "agent_message_chunk");
        assert_eq!(serialized["text"], "hello");
        assert_eq!(output.text, "hello");
    }

    #[test]
    fn sanitizes_every_standard_session_update_variant() {
        let cases = [
            (
                json!({
                    "sessionId": "s1",
                    "update": {
                        "sessionUpdate": "user_message_chunk",
                        "content": { "type": "text", "text": "hello" }
                    }
                }),
                "user_message_chunk",
            ),
            (
                json!({
                    "sessionId": "s1",
                    "update": {
                        "sessionUpdate": "agent_thought_chunk",
                        "content": { "type": "text", "text": "thinking" }
                    }
                }),
                "agent_thought_chunk",
            ),
            (
                json!({
                    "sessionId": "s1",
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "tool-1",
                        "title": "Read source",
                        "kind": "read",
                        "status": "in_progress",
                        "locations": [{ "path": "/workspace/src/main.rs", "line": 12 }]
                    }
                }),
                "tool_call",
            ),
            (
                json!({
                    "sessionId": "s1",
                    "update": {
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": "tool-1",
                        "status": "completed"
                    }
                }),
                "tool_call_update",
            ),
            (
                json!({
                    "sessionId": "s1",
                    "update": {
                        "sessionUpdate": "plan",
                        "entries": [{ "content": "Inspect", "status": "completed", "priority": "high" }]
                    }
                }),
                "plan",
            ),
            (
                json!({
                    "sessionId": "s1",
                    "update": {
                        "sessionUpdate": "available_commands_update",
                        "availableCommands": [{
                            "name": "review",
                            "description": "Review the changes",
                            "input": { "hint": "optional focus" }
                        }]
                    }
                }),
                "available_commands_update",
            ),
            (
                json!({
                    "sessionId": "s1",
                    "update": { "sessionUpdate": "current_mode_update", "currentModeId": "code" }
                }),
                "current_mode_update",
            ),
            (
                json!({
                    "sessionId": "s1",
                    "update": {
                        "sessionUpdate": "config_option_update",
                        "configOptions": [{
                            "id": "reasoning",
                            "name": "Reasoning",
                            "type": "select",
                            "currentValue": "high",
                            "options": []
                        }]
                    }
                }),
                "config_option_update",
            ),
            (
                json!({
                    "sessionId": "s1",
                    "update": {
                        "sessionUpdate": "session_info_update",
                        "title": "A better title",
                        "updatedAt": "2026-07-17T12:00:00Z"
                    }
                }),
                "session_info_update",
            ),
            (
                json!({
                    "sessionId": "s1",
                    "update": {
                        "sessionUpdate": "usage_update",
                        "used": 123,
                        "size": 1000,
                        "cost": { "amount": 0.25, "currency": "usd" }
                    }
                }),
                "usage_update",
            ),
        ];

        for (params, expected_kind) in cases {
            let update = sanitize_session_update(&params).expect(expected_kind);
            let serialized = serde_json::to_value(update).unwrap();
            assert_eq!(serialized["sessionId"], "s1");
            assert_eq!(serialized["kind"], expected_kind);
        }
    }

    #[test]
    fn excludes_raw_tool_data_metadata_and_sensitive_config_values() {
        let tool = sanitize_session_update(&json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "tool-1",
                "title": "Run command",
                "rawInput": { "token": "must-not-leak" },
                "rawOutput": "must-not-leak",
                "content": [{ "content": { "type": "text", "text": "must-not-leak" } }],
                "_meta": { "env": { "API_KEY": "must-not-leak" } }
            }
        }))
        .unwrap();
        let tool_json = serde_json::to_string(&tool).unwrap();
        assert!(!tool_json.contains("must-not-leak"));
        assert!(!tool_json.contains("rawInput"));
        assert!(!tool_json.contains("rawOutput"));
        assert!(!tool_json.contains("_meta"));

        let config = sanitize_session_update(&json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "config_option_update",
                "configOptions": [{
                    "id": "display_mode",
                    "name": "Display mode",
                    "type": "select",
                    "currentValue": "must-not-leak",
                    "options": []
                }]
            }
        }))
        .unwrap();
        assert!(!serde_json::to_string(&config)
            .unwrap()
            .contains("must-not-leak"));
    }

    #[test]
    fn rejects_malformed_tool_updates() {
        assert!(sanitize_session_update(&json!({
            "sessionId": "s1",
            "update": { "sessionUpdate": "tool_call", "title": "Missing ID" }
        }))
        .is_none());
        assert!(sanitize_session_update(&json!({
            "sessionId": "s1",
            "update": { "sessionUpdate": "tool_call_update", "status": "completed" }
        }))
        .is_none());
    }

    #[test]
    fn sanitizes_grok_turn_completion_without_extension_metadata() {
        let update = sanitize_grok_session_update(&json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "turn_completed",
                "stopReason": "cancelled",
                "metrics": {
                    "totalTokens": 500,
                    "outputTokens": 100,
                    "reasoningTokens": 40,
                    "modelCalls": 2,
                    "apiDurationMs": 1200,
                    "privateTrace": "must-not-leak"
                },
                "_meta": { "token": "must-not-leak" }
            }
        }))
        .unwrap();
        let serialized = serde_json::to_value(update).unwrap();

        assert_eq!(serialized["kind"], "turn_completed");
        assert_eq!(serialized["stopReason"], "cancelled");
        assert_eq!(serialized["metrics"]["totalTokens"], 500);
        assert!(!serde_json::to_string(&serialized)
            .unwrap()
            .contains("must-not-leak"));
    }

    #[test]
    fn response_completion_preserves_metrics_from_the_extension_boundary() {
        let extension = SessionUpdateEvent::new(
            "s1",
            SessionUpdatePayload::TurnCompleted {
                stop_reason: "unknown".to_string(),
                metrics: Some(TurnMetrics {
                    total_tokens: Some(500),
                    output_tokens: Some(100),
                    reasoning_tokens: None,
                    model_calls: Some(2),
                    api_duration_ms: None,
                }),
            },
        );
        let response = SessionUpdateEvent::new(
            "s1",
            SessionUpdatePayload::TurnCompleted {
                stop_reason: "end_turn".to_string(),
                metrics: None,
            },
        );
        let mut updates = SessionUpdates::new();

        capture_session_update(&mut updates, &extension);
        capture_session_update(&mut updates, &response);

        assert_eq!(updates["s1"].len(), 1);
        let serialized = serde_json::to_value(&updates["s1"][0]).unwrap();
        assert_eq!(serialized["stopReason"], "end_turn");
        assert_eq!(serialized["metrics"]["totalTokens"], 500);
        assert_eq!(serialized["metrics"]["modelCalls"], 2);
    }

    #[test]
    fn keeps_turn_output_and_history_isolated_by_session() {
        let first = SessionUpdateEvent::new(
            "s1",
            SessionUpdatePayload::AgentMessageChunk {
                text: "first".to_string(),
            },
        );
        let second = SessionUpdateEvent::new(
            "s2",
            SessionUpdatePayload::AgentMessageChunk {
                text: "second".to_string(),
            },
        );
        let mut outputs = HashMap::from([
            ("s1".to_string(), TurnOutput::default()),
            ("s2".to_string(), TurnOutput::default()),
        ]);
        let mut updates = SessionUpdates::new();

        capture_session_turn_output(&mut outputs, &first);
        capture_session_update(&mut updates, &first);
        capture_session_turn_output(&mut outputs, &second);
        capture_session_update(&mut updates, &second);

        assert_eq!(outputs["s1"].text, "first");
        assert_eq!(outputs["s2"].text, "second");
        assert_eq!(updates["s1"], vec![first]);
        assert_eq!(updates["s2"], vec![second]);
    }
}
