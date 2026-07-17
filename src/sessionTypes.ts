import type { EventTiming } from "./timing.ts";

export type ApprovalMode = "ask" | "alwaysApprove";

export type OnboardingStage =
  | "checking"
  | "missingCli"
  | "needsAuth"
  | "ready"
  | "connecting"
  | "connected"
  | "error"
  | "webOnly";

export interface OnboardingStatus {
  stage: Exclude<OnboardingStage, "checking" | "connecting" | "webOnly">;
  cliVersion: string | null;
  suggestedWorkspace: string | null;
  message: string | null;
  accountProfile: AccountProfile | null;
}

export interface AccountProfile {
  displayName: string | null;
  email: string | null;
}

export interface Connection {
  sessionId: string;
  workspace: string | null;
  workingDirectory: string;
  cliVersion: string;
  approvalMode: ApprovalMode;
  models: SessionModelState | null;
  availableCommands: AvailableCommand[];
}

export interface SessionModelState {
  currentModelId: string;
  availableModels: ModelInfo[];
}

export interface ModelInfo {
  modelId: string;
  name: string;
  description?: string | null;
  metadata?: ModelMetadata | null;
}

export interface ModelMetadata {
  totalContextTokens?: number | null;
  agentType?: string | null;
  supportsReasoningEffort?: boolean | null;
  reasoningEffort?: string | null;
  reasoningEfforts?: ReasoningEffortInfo[] | null;
}

export interface ReasoningEffortInfo {
  id: string;
  value: string;
  label: string;
  description?: string | null;
  default?: boolean;
}

export interface PromptResult {
  stopReason: StopReason;
  text: string;
  thought: string;
}

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled"
  | "unknown";

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export type ConversationState =
  | "streaming"
  | "historical"
  | "complete"
  | "cancelled"
  | "refused"
  | "limited"
  | "error";

export interface ToolLocation {
  path: string;
  line?: number | null;
}

export interface AvailableCommand {
  name: string;
  description: string;
  inputHint?: string | null;
}

export interface SessionConfigOption {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  value?: boolean | null;
}

export interface SessionUsage {
  used: number;
  size: number;
  cost?: { amount: number; currency: string } | null;
}

export interface TurnMetrics {
  totalTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  modelCalls?: number | null;
  apiDurationMs?: number | null;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  title: string;
  toolKind?: string | null;
  options: PermissionOption[];
}

export interface ToolActivity extends EventTiming {
  id: string;
  title: string;
  kind?: string;
  status: ToolStatus;
  locations?: ToolLocation[];
}

export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "low" | "medium" | "high" | null;
}

export interface PermissionDecision {
  requestId: string;
  toolCallId: string;
  title: string;
  label: string;
  outcome: "allowed" | "rejected" | "dismissed";
}

export type TurnTimelineItem =
  | ({
      id: string;
      kind: "thought";
      text: string;
      open: boolean;
    } & EventTiming)
  | { id: string; kind: "response"; text: string }
  | { id: string; kind: "tool"; tool: ToolActivity }
  | ({
      id: string;
      kind: "permission";
      requestId: string;
      toolCallId: string;
      title: string;
      decision?: PermissionDecision;
    } & EventTiming);

export interface MessageAttachment {
  name: string;
  size: number;
  mimeType?: string | null;
}

export interface FileAttachment extends MessageAttachment {
  path: string;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  startedAt?: number;
  elapsedMs?: number;
  timeline?: TurnTimelineItem[];
  attachments?: MessageAttachment[];
  metrics?: TurnMetrics;
  stopReason?: StopReason;
  state?: ConversationState;
  error?: string;
}

export type SessionUpdate = { sessionId: string } & (
  | { kind: "user_message_chunk"; text: string; attachments?: MessageAttachment[] }
  | { kind: "agent_message_chunk" | "agent_thought_chunk"; text: string }
  | {
      kind: "tool_call" | "tool_call_update";
      toolCallId: string;
      title?: string | null;
      toolKind?: string | null;
      status?: ToolStatus | null;
      locations?: ToolLocation[] | null;
    }
  | { kind: "plan"; entries: PlanEntry[] }
  | { kind: "available_commands_update"; availableCommands: AvailableCommand[] }
  | { kind: "current_mode_update"; currentModeId: string }
  | { kind: "config_option_update"; configOptions: SessionConfigOption[] }
  | { kind: "session_info_update"; title?: string | null; updatedAt?: string | null }
  | { kind: "usage_update"; used: number; size: number; cost?: SessionUsage["cost"] }
  | { kind: "turn_completed"; stopReason: StopReason; metrics?: TurnMetrics | null }
  | {
      kind: "permission_requested";
      requestId: string;
      toolCallId: string;
      title: string;
      toolKind?: string | null;
      options: PermissionOption[];
    }
  | {
      kind: "permission_decision";
      requestId: string;
      toolCallId: string;
      title: string;
      label: string;
      outcome: PermissionDecision["outcome"];
    }
);

export interface ConnectionEvent {
  status: "connected" | "disconnected";
  message?: string | null;
  sessionIds?: string[];
}

export interface DeviceAuthCodeEvent {
  code: string;
}

export interface SessionViewState {
  connection: Connection;
  disconnected: boolean;
  messages: ConversationMessage[];
  draft: string;
  attachments: FileAttachment[];
  running: boolean;
  permissions: PermissionRequest[];
  availableCommands: AvailableCommand[];
  currentModeId: string | null;
  configOptions: SessionConfigOption[];
  usage: SessionUsage | null;
  plan: PlanEntry[];
}

export interface ConversationTurnPreview {
  id: string;
  request: string;
  response: string;
}

export interface SidebarSessionSummary {
  sessionId: string;
  title: string;
  workspace: string | null;
  running: boolean;
  needsAttention: boolean;
  updatedAt: number;
  archived: boolean;
  unread: boolean;
}

export interface SidebarWorkspaceGroup {
  path: string;
  sessions: SidebarSessionSummary[];
}

export interface PersistedSessionSummary {
  sessionId: string;
  title: string;
  workspace: string | null;
  updatedAt: number;
  archived: boolean;
  unread: boolean;
}

export interface PersistedWorkspaceSummary {
  path: string;
}

export interface LoadSessionResult {
  connection: Connection;
  updates: SessionUpdate[];
}

export interface AppUpdateInfo {
  currentVersion: string;
  version: string;
  body: string | null;
  date: string | null;
}

export interface AppUpdateProgress {
  stage: "downloading" | "downloaded" | "installing";
  downloaded: number;
  total: number | null;
}
