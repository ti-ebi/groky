use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
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

type PendingResponse = oneshot::Sender<Result<Value, String>>;
type PendingResponses = HashMap<u64, PendingResponse>;

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalMode {
    #[default]
    Ask,
    AlwaysApprove,
}

impl ApprovalMode {
    fn agent_args(self) -> Vec<&'static str> {
        let mut args = vec!["--no-auto-update", "--permission-mode"];

        match self {
            Self::Ask => args.extend(["default", "agent", "stdio"]),
            Self::AlwaysApprove => args.extend(["bypassPermissions", "agent", "stdio"]),
        }

        args
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
    rpc_id: Value,
    session_id: String,
}

#[derive(Debug, Clone, Serialize)]
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
    title: String,
    tool_kind: Option<String>,
    options: Vec<PermissionOptionEvent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionEvent {
    status: &'static str,
    message: Option<&'static str>,
}

#[derive(Clone)]
pub struct AcpTransport {
    writer: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    pending: Arc<Mutex<PendingResponses>>,
    permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    turn_output: Arc<Mutex<TurnOutput>>,
    replay_updates: Arc<Mutex<Option<Vec<Value>>>>,
    shutdown_requested: Arc<AtomicBool>,
    next_id: Arc<AtomicU64>,
}

#[derive(Debug, Default, Clone)]
pub struct TurnOutput {
    pub text: String,
    pub thought: String,
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
        let turn_output = Arc::new(Mutex::new(TurnOutput::default()));
        let replay_updates = Arc::new(Mutex::new(None));
        let shutdown_requested = Arc::new(AtomicBool::new(false));
        let permission_counter = Arc::new(AtomicU64::new(1));

        spawn_reader(
            stdout,
            writer.clone(),
            pending.clone(),
            permissions.clone(),
            turn_output.clone(),
            replay_updates.clone(),
            shutdown_requested.clone(),
            permission_counter,
            event_sink,
        );

        Ok(Self {
            writer,
            child: Arc::new(Mutex::new(child)),
            pending,
            permissions,
            turn_output,
            replay_updates,
            shutdown_requested,
            next_id: Arc::new(AtomicU64::new(1)),
        })
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request_with_timeout(method, params, REQUEST_TIMEOUT)
            .await
    }

    pub async fn prompt(
        &self,
        session_id: &str,
        prompt: &str,
    ) -> Result<(Value, TurnOutput), String> {
        *self.turn_output.lock().await = TurnOutput::default();
        let response = self
            .request_with_timeout(
                "session/prompt",
                json!({
                    "sessionId": session_id,
                    "prompt": [{ "type": "text", "text": prompt }]
                }),
                PROMPT_TIMEOUT,
            )
            .await?;
        let output = self.turn_output.lock().await.clone();
        Ok((response, output))
    }

    pub async fn load_session(
        &self,
        session_id: &str,
        cwd: &str,
    ) -> Result<(Value, Vec<Value>), String> {
        *self.replay_updates.lock().await = Some(Vec::new());
        let response = self
            .request("session/load", load_session_params(session_id, cwd))
            .await;
        let updates = self.replay_updates.lock().await.take().unwrap_or_default();
        response.map(|response| (response, updates))
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
            let tokens = permissions
                .iter()
                .filter_map(|(token, pending)| {
                    (pending.session_id == session_id).then_some(token.clone())
                })
                .collect::<Vec<_>>();
            tokens
                .into_iter()
                .filter_map(|token| permissions.remove(&token))
                .collect::<Vec<_>>()
        };

        for permission in cancelled {
            write_permission_response(&self.writer, permission.rpc_id, None).await?;
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
        request_id: &str,
        option_id: Option<&str>,
    ) -> Result<(), String> {
        let permission = self
            .permissions
            .lock()
            .await
            .remove(request_id)
            .ok_or_else(|| "This permission request has already been resolved.".to_string())?;

        write_permission_response(&self.writer, permission.rpc_id, option_id).await
    }

    pub async fn shutdown(&self) {
        self.shutdown_requested.store(true, Ordering::Release);
        let _ = self.child.lock().await.kill().await;
    }
}

fn spawn_reader(
    stdout: tokio::process::ChildStdout,
    writer: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<PendingResponses>>,
    permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    turn_output: Arc<Mutex<TurnOutput>>,
    replay_updates: Arc<Mutex<Option<Vec<Value>>>>,
    shutdown_requested: Arc<AtomicBool>,
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
                Err(_) => continue,
            };

            match frame {
                InboundFrame::Response { id, response } => {
                    route_response(&mut *pending.lock().await, id, response);
                }
                InboundFrame::Notification { method, params } => {
                    if method == "session/update" {
                        if let Some(update) = sanitize_session_update(&params) {
                            capture_turn_output(&mut *turn_output.lock().await, &update);
                            capture_replay_update(&mut *replay_updates.lock().await, &update);
                            if let Some(app) = event_sink.as_ref() {
                                let _ = app.emit("grok://session-update", update);
                            }
                        }
                    }
                }
                InboundFrame::Request { id, method, params } => {
                    if method == "session/request_permission" {
                        if let Some(request) = sanitize_permission_request(
                            id.clone(),
                            &params,
                            &permissions,
                            &permission_counter,
                        )
                        .await
                        {
                            let request_id = request.request_id.clone();
                            if let Some(app) = event_sink.as_ref() {
                                if app.emit("grok://permission-request", request).is_ok() {
                                    continue;
                                }
                            }

                            permissions.lock().await.remove(&request_id);
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

        if !shutdown_requested.load(Ordering::Acquire) {
            if let Some(app) = event_sink {
                let _ = app.emit(
                    "grok://connection",
                    ConnectionEvent {
                        status: "disconnected",
                        message: Some("The connection to Grok Build was closed."),
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

    let response = if let Some(error) = object.get("error") {
        Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Grok Build returned an error.")
            .to_string())
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
    let session_id = params.get("sessionId")?.as_str()?.to_string();
    let tool_call = params.get("toolCall")?;
    let title = tool_call
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Grok Build is requesting permission to perform an action")
        .to_string();
    let tool_kind = tool_call
        .get("kind")
        .and_then(Value::as_str)
        .map(str::to_string);
    let options = params
        .get("options")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|option| {
            Some(PermissionOptionEvent {
                option_id: option.get("optionId")?.as_str()?.to_string(),
                name: option.get("name")?.as_str()?.to_string(),
                kind: option
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("allow_once")
                    .to_string(),
            })
        })
        .collect::<Vec<_>>();

    if options.is_empty() {
        return None;
    }

    let request_id = format!("permission-{}", counter.fetch_add(1, Ordering::Relaxed));
    permissions.lock().await.insert(
        request_id.clone(),
        PendingPermission {
            rpc_id,
            session_id: session_id.clone(),
        },
    );

    Some(PermissionRequestEvent {
        request_id,
        session_id,
        title,
        tool_kind,
        options,
    })
}

fn sanitize_session_update(params: &Value) -> Option<Value> {
    let session_id = params.get("sessionId")?.as_str()?;
    let update = params.get("update")?;
    let update_kind = update.get("sessionUpdate")?.as_str()?;

    let payload = match update_kind {
        "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk" => json!({
            "sessionId": session_id,
            "kind": update_kind,
            "text": update.get("content").and_then(|content| content.get("text")).and_then(Value::as_str).unwrap_or_default(),
        }),
        "tool_call" | "tool_call_update" => json!({
            "sessionId": session_id,
            "kind": update_kind,
            "toolCallId": update.get("toolCallId").and_then(Value::as_str),
            "title": update.get("title").and_then(Value::as_str),
            "toolKind": update.get("kind").and_then(Value::as_str),
            "status": update.get("status").and_then(Value::as_str),
        }),
        "plan" => json!({
            "sessionId": session_id,
            "kind": update_kind,
            "entries": update.get("entries").and_then(Value::as_array).map(|entries| entries.iter().filter_map(|entry| {
                Some(json!({
                    "content": entry.get("content")?.as_str()?,
                    "status": entry.get("status").and_then(Value::as_str).unwrap_or("pending")
                }))
            }).collect::<Vec<_>>()).unwrap_or_default(),
        }),
        _ => return None,
    };

    Some(payload)
}

fn capture_turn_output(output: &mut TurnOutput, update: &Value) {
    let Some(text) = update.get("text").and_then(Value::as_str) else {
        return;
    };
    match update.get("kind").and_then(Value::as_str) {
        Some("agent_message_chunk") => output.text.push_str(text),
        Some("agent_thought_chunk") => output.thought.push_str(text),
        _ => {}
    }
}

fn capture_replay_update(replay: &mut Option<Vec<Value>>, update: &Value) {
    if let Some(updates) = replay.as_mut() {
        updates.push(update.clone());
    }
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
    async fn correlates_response_to_the_matching_request() {
        let (sender, receiver) = oneshot::channel();
        let mut pending = PendingResponses::new();
        pending.insert(7, sender);

        assert!(route_response(&mut pending, 7, Ok(json!({ "ok": true }))));
        assert!(!route_response(&mut pending, 8, Ok(json!({}))));
        assert_eq!(receiver.await.unwrap().unwrap()["ok"], true);
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
                "toolCall": { "title": "Run cargo test", "kind": "execute" },
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
        assert_eq!(event.options[0].kind, "allow_once");
        assert_eq!(event.options[1].kind, "allow_always");
        assert_eq!(event.options[2].kind, "reject_once");
        assert_eq!(permissions.lock().await.len(), 1);
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

        assert_eq!(update["kind"], "agent_message_chunk");
        assert_eq!(update["text"], "hello");
        assert_eq!(output.text, "hello");
    }

    #[test]
    fn captures_sanitized_updates_only_while_replaying_history() {
        let update = json!({
            "sessionId": "s1",
            "kind": "user_message_chunk",
            "text": "hello"
        });
        let mut inactive = None;
        capture_replay_update(&mut inactive, &update);
        assert!(inactive.is_none());

        let mut active = Some(Vec::new());
        capture_replay_update(&mut active, &update);
        assert_eq!(active, Some(vec![update]));
    }
}
