import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@fontsource-variable/sora/index.css";
import "./App.css";

type IconName =
  | "archive"
  | "arrow-right"
  | "arrow-down"
  | "arrow-up"
  | "branch"
  | "check"
  | "chevron-down"
  | "compose"
  | "copy"
  | "dots"
  | "download"
  | "external-link"
  | "folder"
  | "folder-x"
  | "folder-open"
  | "logout"
  | "panel"
  | "plus"
  | "refresh"
  | "search"
  | "sliders"
  | "stop"
  | "terminal"
  | "trash"
  | "x";

type OnboardingStage =
  | "checking"
  | "missingCli"
  | "needsAuth"
  | "ready"
  | "connecting"
  | "connected"
  | "error"
  | "webOnly";

interface OnboardingStatus {
  stage: Exclude<OnboardingStage, "checking" | "connecting" | "webOnly">;
  cliVersion: string | null;
  suggestedWorkspace: string | null;
  message: string | null;
}

interface Connection {
  sessionId: string;
  workspace: string | null;
  workingDirectory: string;
  cliVersion: string;
  approvalMode: ApprovalMode;
  models: SessionModelState | null;
}

interface SessionModelState {
  currentModelId: string;
  availableModels: ModelInfo[];
}

interface ModelInfo {
  modelId: string;
  name: string;
  description?: string | null;
  _meta?: ModelMetadata | null;
}

interface ModelMetadata {
  totalContextTokens?: number | null;
  agentType?: string | null;
  supportsReasoningEffort?: boolean | null;
  reasoningEffort?: string | null;
  reasoningEfforts?: ReasoningEffortInfo[] | null;
}

interface ReasoningEffortInfo {
  id: string;
  value: string;
  label: string;
  description?: string | null;
  default?: boolean;
}

interface PromptResult {
  stopReason: string | null;
  text: string;
  thought: string;
}

interface SessionUpdate {
  sessionId: string;
  kind:
    | "agent_message_chunk"
    | "agent_thought_chunk"
    | "user_message_chunk"
    | "tool_call"
    | "tool_call_update"
    | "plan";
  text?: string;
  toolCallId?: string | null;
  title?: string | null;
  toolKind?: string | null;
  status?: string | null;
  entries?: PlanEntry[];
}

interface ConnectionEvent {
  status: "connected" | "disconnected";
  message?: string | null;
}

interface DeviceAuthCodeEvent {
  code: string;
}

interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

interface PermissionRequest {
  requestId: string;
  sessionId: string;
  title: string;
  toolKind?: string | null;
  options: PermissionOption[];
}

interface ToolActivity {
  id: string;
  title: string;
  kind?: string;
  status?: string;
}

interface PlanEntry {
  content: string;
  status: string;
}

interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  startedAt?: number;
  elapsedMs?: number;
  thought?: string;
  thoughtActive?: boolean;
  thoughtStartedAt?: number;
  thoughtElapsedMs?: number;
  tools?: ToolActivity[];
  plan?: PlanEntry[];
  state?: "streaming" | "complete" | "cancelled" | "error";
  error?: string;
}

interface ConversationTurnPreview {
  id: string;
  request: string;
  response: string;
}

interface SidebarSessionSummary {
  sessionId: string;
  title: string;
  workspace: string | null;
  running: boolean;
  updatedAt: number;
  archived: boolean;
}

interface SidebarWorkspaceGroup {
  path: string;
  sessions: SidebarSessionSummary[];
}

interface PersistedSessionSummary {
  sessionId: string;
  title: string;
  workspace: string | null;
  updatedAt: number;
  archived: boolean;
}

interface PersistedWorkspaceSummary {
  path: string;
}

interface LoadSessionResult {
  connection: Connection;
  updates: SessionUpdate[];
}

type SidebarMenu =
  | { kind: "workspace"; path: string }
  | { kind: "session"; sessionId: string }
  | null;

interface DeleteConfirmation {
  sessionId?: string;
  workspace?: string;
  title: string;
  description: string;
}

type SessionHistoryAction = "archive" | "restore" | "delete";

interface AppUpdateInfo {
  currentVersion: string;
  version: string;
  body: string | null;
  date: string | null;
}

function finishThought(message: ConversationMessage, endedAt: number) {
  if (!message.thoughtActive || message.thoughtStartedAt === undefined) {
    return { ...message, thoughtActive: false, thoughtStartedAt: undefined };
  }

  return {
    ...message,
    thoughtActive: false,
    thoughtStartedAt: undefined,
    thoughtElapsedMs: (message.thoughtElapsedMs ?? 0) + Math.max(0, endedAt - message.thoughtStartedAt),
  };
}

function finishRun(message: ConversationMessage, endedAt: number) {
  const finished = finishThought(message, endedAt);
  return {
    ...finished,
    elapsedMs: message.startedAt === undefined ? undefined : Math.max(0, endedAt - message.startedAt),
  };
}

function formatDuration(elapsedMs: number) {
  const safeElapsedMs = Math.max(0, elapsedMs);
  const totalSeconds = Math.floor(safeElapsedMs / 1000);
  if (totalSeconds < 10) return `${(safeElapsedMs / 1000).toFixed(1)}s`;
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${seconds}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function formatThoughtDuration(elapsedMs: number) {
  const totalSeconds = Math.max(0, elapsedMs) / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;

  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m${(totalSeconds - minutes * 60).toFixed(0)}s`;
}

interface AppUpdateProgress {
  stage: "downloading" | "downloaded" | "installing";
  downloaded: number;
  total: number | null;
}

type AppUpdatePhase = "idle" | "checking" | "available" | "downloading" | "error";
type ApprovalMode = "ask" | "alwaysApprove";

interface ApprovalModeOption {
  id: ApprovalMode;
  label: string;
  shortDescription: string;
  description: string;
  glyph: string;
  tag?: string;
}

const APPROVAL_MODES: ApprovalModeOption[] = [
  {
    id: "ask",
    label: "Ask",
    shortDescription: "Review actions",
    description: "Ask before actions that are not already allowed.",
    glyph: "?",
    tag: "Recommended",
  },
  {
    id: "alwaysApprove",
    label: "Always approve",
    shortDescription: "Approval prompts skipped",
    description: "Skip prompts unless a policy rule still requires approval.",
    glyph: "!",
  },
];

const approvalModeOption = (mode: ApprovalMode) =>
  APPROVAL_MODES.find((option) => option.id === mode) ?? APPROVAL_MODES[0];

function currentModel(models: SessionModelState | null) {
  if (!models) return null;
  return models.availableModels.find((model) => model.modelId === models.currentModelId) ?? null;
}

function enablesAlwaysApprove(option: PermissionOption | undefined) {
  if (!option || option.kind !== "allow_always") return false;

  const id = option.optionId.toLowerCase().replace(/_/g, "-");
  const name = option.name.toLowerCase();
  return id.includes("always-approve")
    || name.includes("always approve")
    || name.includes("all sessions")
    || name.includes("all tool");
}

const isTauri = () => "__TAURI_INTERNALS__" in window;
const isMacOS = () => /Macintosh|Mac OS X|MacIntel/.test(`${navigator.userAgent} ${navigator.platform}`);
const usesOverlayTitlebar = () => isTauri() && isMacOS();
const AUTH_REQUIRED_ERROR = "GROK_AUTH_REQUIRED";
const SIDEBAR_WIDTH_KEY = "groky.sidebar.width";
const SIDEBAR_COLLAPSED_KEY = "groky.sidebar.collapsed";
const DEFAULT_SIDEBAR_WIDTH = 258;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;

function clampSidebarWidth(width: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function storedSidebarWidth() {
  try {
    const width = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(width) && width > 0 ? clampSidebarWidth(width) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function storedSidebarCollapsed() {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    archive: <><path d="M4 7h16" /><path d="M5 7v12h14V7" /><path d="M3 4h18v3H3Z" /><path d="M9 11h6" /></>,
    "arrow-right": <><path d="m9 18 6-6-6-6" /><path d="M5 12h10" /></>,
    "arrow-down": <><path d="m6 9 6 6 6-6" /><path d="M12 5v10" /></>,
    "arrow-up": <><path d="m18 15-6-6-6 6" /><path d="M12 9v10" /></>,
    branch: <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M8 7c3 0 3-1 3-1h5M11 6v7c0 3-3 3-3 3" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    "chevron-down": <path d="m8 10 4 4 4-4" />,
    compose: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L9 17l-4 1 1-4Z" /></>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
    dots: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
    download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" /></>,
    "external-link": <><path d="M14 5h5v5" /><path d="m19 5-8 8" /><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></>,
    folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
    "folder-x": <><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="m10 11 4 4m0-4-4 4" /></>,
    "folder-open": <><path d="M3 9V7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v1" /><path d="m3 10 2 9h14l2-9Z" /></>,
    logout: <><path d="M10 5H5v14h5" /><path d="M14 8l4 4-4 4M8 12h10" /></>,
    panel: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M15 4v16" /></>,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    refresh: <><path d="M20 6v5h-5" /><path d="M4 18v-5h5" /><path d="M18 9a7 7 0 0 0-12-2L4 11M6 15a7 7 0 0 0 12 2l2-4" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    sliders: <><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>,
    stop: <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3M13 15h4" /></>,
    trash: <><path d="M4 7h16" /><path d="m9 7 .5-3h5l.5 3" /><path d="m6 7 1 13h10l1-13" /><path d="M10 11v5M14 11v5" /></>,
    x: <><path d="m7 7 10 10M17 7 7 17" /></>,
  };

  return (
    <svg
      aria-hidden="true"
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

function Brand() {
  return (
    <div className="brand-identity">
      <span className="groky-mark" aria-hidden="true"><span /><span /></span>
      <strong>Groky</strong>
    </div>
  );
}

function workspaceName(path: string | null) {
  if (!path) return "No working directory";
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function groupSidebarSessions(sessions: SidebarSessionSummary[]) {
  const groups = new Map<string, SidebarSessionSummary[]>();
  const ungrouped: SidebarSessionSummary[] = [];

  sessions.forEach((session) => {
    if (!session.workspace) {
      ungrouped.push(session);
      return;
    }

    const group = groups.get(session.workspace) ?? [];
    group.push(session);
    groups.set(session.workspace, group);
  });

  return {
    workspaceGroups: Array.from(groups, ([path, groupedSessions]) => ({
      path,
      sessions: groupedSessions,
    })),
    ungrouped,
  };
}

function SidebarSessionRow({
  session,
  selected,
  disabled,
  menuOpen,
  subtitle,
  onSelect,
  onToggleMenu,
  onArchive,
  onRestore,
  onDelete,
}: {
  session: SidebarSessionSummary;
  selected: boolean;
  disabled: boolean;
  menuOpen: boolean;
  subtitle?: string;
  onSelect: () => void;
  onToggleMenu: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={`session-row ${selected ? "selected" : ""}`} data-sidebar-menu-root>
      <button
        className="session-main"
        type="button"
        aria-current={selected ? "page" : undefined}
        disabled={disabled}
        title={session.title}
        onClick={onSelect}
      >
        <span className="session-copy">
          <span>{session.title}</span>
          {subtitle && <small>{subtitle}</small>}
        </span>
        {session.running && (
          <span className="session-running-indicator" aria-label="Running">
            <span className="task-status" aria-hidden="true" />
          </span>
        )}
      </button>
      <div className="session-row-actions">
        <button
          className="session-more"
          type="button"
          aria-label={`Session actions for ${session.title}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={disabled}
          onClick={onToggleMenu}
        >
          <Icon name="dots" size={15} />
        </button>
        <button
          className="session-archive"
          type="button"
          aria-label={`${session.archived ? "Restore" : "Archive"} ${session.title}`}
          title={session.archived ? "Restore session" : "Archive session"}
          disabled={disabled}
          onClick={session.archived ? onRestore : onArchive}
        >
          <Icon name={session.archived ? "refresh" : "archive"} size={14} />
        </button>
      </div>
      {menuOpen && (
        <div className="sidebar-context-menu session-context-menu" role="menu">
          <button className="danger-menu-item" type="button" role="menuitem" onClick={onDelete}>
            <Icon name="trash" size={14} />
            <span>Delete</span>
          </button>
        </div>
      )}
    </div>
  );
}

function SessionLocationSelector({
  value,
  workspaces,
  disabled,
  onChange,
  onAddWorkspace,
}: {
  value: string | null;
  workspaces: string[];
  disabled: boolean;
  onChange: (workspace: string | null) => void;
  onAddWorkspace: () => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [addingWorkspace, setAddingWorkspace] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const label = value ? workspaceName(value) : "Standalone";
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredWorkspaces = workspaces.filter((path) =>
    !normalizedQuery
    || workspaceName(path).toLocaleLowerCase().includes(normalizedQuery)
    || path.toLocaleLowerCase().includes(normalizedQuery)
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const frame = window.requestAnimationFrame(() => searchInput.current?.focus());
    const handlePointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function select(workspace: string | null) {
    onChange(workspace);
    setOpen(false);
  }

  async function addWorkspace() {
    setOpen(false);
    setAddingWorkspace(true);
    const added = await onAddWorkspace();
    setAddingWorkspace(false);
    if (added) onChange(added);
  }

  return (
    <div className="session-location-control" ref={root}>
      <button
        className="session-location-button"
        type="button"
        aria-label={`Session location: ${label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled || addingWorkspace}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name={value ? "folder" : "compose"} size={14} />
        <span>{label}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {open && (
        <div className="session-location-menu" role="menu" aria-label="Working directory for this session">
          <label className="session-location-search">
            <Icon name="search" size={13} />
            <input
              ref={searchInput}
              type="search"
              aria-label="Search working directories"
              placeholder="Search working directories"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="session-location-workspaces">
            {filteredWorkspaces.map((path) => (
              <button
                className="session-location-option"
                type="button"
                role="menuitemradio"
                aria-checked={value === path}
                key={path}
                title={path}
                onClick={() => select(path)}
              >
                <Icon name="folder" size={14} />
                <span>{workspaceName(path)}</span>
                {value === path && <Icon name="check" size={14} />}
              </button>
            ))}
            {filteredWorkspaces.length === 0 && (
              <p className="session-location-empty">
                {workspaces.length === 0 ? "No working directories yet" : "No matching working directories"}
              </p>
            )}
          </div>
          <div className="session-location-actions">
            <button className="session-location-action" type="button" role="menuitem" onClick={() => void addWorkspace()}>
              <Icon name="plus" size={14} />
              <span>Add working directory</span>
            </button>
            <button
              className="session-location-action"
              type="button"
              role="menuitemradio"
              aria-checked={value === null}
              onClick={() => select(null)}
            >
              <Icon name="compose" size={14} />
              <span>Standalone</span>
              {value === null && <Icon name="check" size={14} />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function cleanVersion(version: string | null) {
  return version?.replace(/^grok\s+/, "") ?? "not detected";
}

function makeMessageId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resizeTextareaToContent(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function titleFromPrompt(prompt: string) {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  const characters = Array.from(normalized);
  return characters.length > 72 ? `${characters.slice(0, 71).join("")}…` : normalized || "New Grok session";
}

function messagesFromSessionReplay(sessionId: string, updates: SessionUpdate[]) {
  const messages: ConversationMessage[] = [];
  const currentAssistant = () => {
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") return last;
    const assistant: ConversationMessage = {
      id: makeMessageId("replayed-assistant"),
      role: "assistant",
      text: "",
      state: "complete",
    };
    messages.push(assistant);
    return assistant;
  };

  updates.filter((update) => update.sessionId === sessionId).forEach((update) => {
    if (update.kind === "user_message_chunk") {
      const last = messages[messages.length - 1];
      if (last?.role === "user") last.text += update.text ?? "";
      else messages.push({
        id: makeMessageId("replayed-user"),
        role: "user",
        text: update.text ?? "",
      });
      return;
    }

    const assistant = currentAssistant();
    if (update.kind === "agent_message_chunk") {
      assistant.text += update.text ?? "";
    } else if (update.kind === "agent_thought_chunk") {
      assistant.thought = (assistant.thought ?? "") + (update.text ?? "");
    } else if (update.kind === "plan") {
      assistant.plan = update.entries ?? [];
    } else if (update.kind === "tool_call" || update.kind === "tool_call_update") {
      const id = update.toolCallId ?? `replayed-tool-${assistant.tools?.length ?? 0}`;
      const tools = assistant.tools ?? [];
      const index = tools.findIndex((tool) => tool.id === id);
      const existing = index >= 0 ? tools[index] : undefined;
      const tool: ToolActivity = {
        id,
        title: update.title ?? existing?.title ?? "Worked with a local tool",
        kind: update.toolKind ?? existing?.kind ?? undefined,
        status: update.status ?? existing?.status ?? "completed",
      };
      if (index >= 0) tools[index] = tool;
      else tools.push(tool);
      assistant.tools = tools;
    }
  });

  return messages;
}

function previewText(text: string, limit: number) {
  const normalized = text.trim().replace(/\s+/g, " ");
  const characters = Array.from(normalized);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : normalized;
}

function conversationTurnPreviews(messages: ConversationMessage[]) {
  const turns: ConversationTurnPreview[] = [];

  messages.forEach((message) => {
    if (message.role === "user") {
      turns.push({
        id: message.id,
        request: previewText(message.text, 96) || "Untitled request",
        response: "Waiting for Grok's response…",
      });
      return;
    }

    const turn = turns[turns.length - 1];
    if (!turn) return;

    const response = previewText(message.text, 240);
    if (response) {
      turn.response = response;
    } else if (message.state === "error") {
      turn.response = "This turn failed before a response was returned.";
    } else if (message.state === "cancelled") {
      turn.response = "This turn was cancelled before a response was returned.";
    } else if (message.state !== "streaming") {
      turn.response = "No response text was returned for this turn.";
    }
  });

  return turns;
}

function MessageHistoryNav({
  turns,
  activeId,
  onNavigate,
}: {
  turns: ConversationTurnPreview[];
  activeId: string | null;
  onNavigate: (messageId: string) => void;
}) {
  const [previewedId, setPreviewedId] = useState<string | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const previewedTurn = turns.find((turn) => turn.id === previewedId) ?? null;
  const previewedTurnNumber = previewedTurn
    ? String(turns.findIndex((turn) => turn.id === previewedTurn.id) + 1).padStart(2, "0")
    : null;
  const turnCount = String(turns.length).padStart(2, "0");

  useEffect(() => {
    if (previewedId && !previewedTurn) setPreviewedId(null);
  }, [previewedId, previewedTurn]);

  useEffect(() => {
    const listElement = list.current;
    const activeMarker = listElement?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!listElement || !activeMarker) return;

    const markerTop = activeMarker.offsetTop;
    const markerBottom = markerTop + activeMarker.offsetHeight;
    if (markerTop < listElement.scrollTop) {
      listElement.scrollTop = markerTop;
    } else if (markerBottom > listElement.scrollTop + listElement.clientHeight) {
      listElement.scrollTop = markerBottom - listElement.clientHeight;
    }
  }, [activeId]);

  if (turns.length < 2) return null;

  return (
    <nav className="message-history-nav" aria-label="Message history">
      <div className="message-history-list" ref={list} role="list">
        {turns.map((turn, index) => {
          const active = turn.id === activeId;
          return (
            <div role="listitem" key={turn.id}>
              <button
                className="message-history-marker"
                type="button"
                aria-label={`Go to request ${index + 1}: ${turn.request}`}
                aria-current={active ? "step" : undefined}
                onClick={() => onNavigate(turn.id)}
                onFocus={() => setPreviewedId(turn.id)}
                onBlur={() => setPreviewedId(null)}
                onMouseEnter={() => setPreviewedId(turn.id)}
                onMouseLeave={() => setPreviewedId(null)}
              >
                <span className="message-history-tick" />
              </button>
            </div>
          );
        })}
      </div>

      {previewedTurn && (
        <div className="message-history-preview" aria-hidden="true">
          <span className="message-history-preview-meta">
            <i />Turn {previewedTurnNumber} / {turnCount}
          </span>
          <strong>{previewedTurn.request}</strong>
          <span className="message-history-preview-response">{previewedTurn.response}</span>
        </div>
      )}
    </nav>
  );
}

async function copyToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through for webviews where the Clipboard API is present but unavailable.
    }
  }

  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    if (!document.execCommand("copy")) throw new Error("Clipboard copy failed");
  } finally {
    textarea.remove();
    activeElement?.focus({ preventScroll: true });
  }
}

function Onboarding({
  stage,
  status,
  busyLabel,
  deviceAuthCode,
  error,
  titlebarHeight,
  onRetry,
  onOpenInstallGuide,
  onLogin,
}: {
  stage: OnboardingStage;
  status: OnboardingStatus | null;
  busyLabel: string | null;
  deviceAuthCode: string | null;
  error: string | null;
  titlebarHeight: number | null;
  onRetry: () => void;
  onOpenInstallGuide: () => void;
  onLogin: () => void;
}) {
  const overlayTitlebar = usesOverlayTitlebar();
  const dragRegionProps = overlayTitlebar ? { "data-tauri-drag-region": "" } : {};
  const cliReady = !["checking", "missingCli", "webOnly"].includes(stage);
  const authReady = ["ready", "connecting", "connected"].includes(stage);
  const currentStep = stage === "checking" ? "00" : stage === "missingCli" ? "01" : "02";
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const copyResetTimer = useRef<number | null>(null);
  const copyLabel = copyState === "copied" ? "COPIED" : copyState === "error" ? "RETRY" : "COPY";

  useEffect(() => {
    setCopyState("idle");
    return () => {
      if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current);
    };
  }, [deviceAuthCode]);

  async function copyAuthCode() {
    if (!deviceAuthCode) return;

    try {
      await copyToClipboard(deviceAuthCode);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }

    if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current);
    copyResetTimer.current = window.setTimeout(() => setCopyState("idle"), 2200);
  }

  return (
    <div
      className={`onboarding-shell ${overlayTitlebar ? "has-overlay-titlebar" : ""}`}
      style={overlayTitlebar && titlebarHeight !== null
        ? { "--app-header-height": `${titlebarHeight}px` } as CSSProperties
        : undefined}
    >
      <header className="onboarding-header" {...dragRegionProps}>
        <Brand />
        <span>Desktop client for Grok Build</span>
      </header>

      <main className="onboarding-main">
        <section className={`setup-card ${deviceAuthCode ? "auth-code-active" : ""}`} aria-live="polite">
          <div className="setup-card-topline">
            <span>SETUP / {currentStep}</span>
            <span className="setup-signal"><i /><i /><i /><i /><i /></span>
          </div>

          <div className="setup-copy">
            {stage === "checking" && (
              <>
                <p className="setup-kicker">SYSTEM CHECK</p>
                <h1>Looking for<br />Grok Build.</h1>
                <p>Checking the local CLI and its authentication state.</p>
              </>
            )}

            {stage === "webOnly" && (
              <>
                <p className="setup-kicker">DESKTOP REQUIRED</p>
                <h1>Open Groky<br />as an app.</h1>
                <p>The web preview cannot start local processes. Run <code>pnpm tauri dev</code> to continue.</p>
              </>
            )}

            {stage === "missingCli" && (
              <>
                <p className="setup-kicker">GROK BUILD CLI</p>
                <h1>First, install<br />the engine.</h1>
                <p>Groky uses the official Grok Build CLI locally. It never proxies your credentials.</p>
                <div className="setup-actions">
                  <button className="primary-action" type="button" onClick={onOpenInstallGuide}>
                    Open install guide <Icon name="external-link" size={15} />
                  </button>
                  <button className="secondary-action" type="button" onClick={onRetry}>
                    <Icon name="refresh" size={15} /> Check again
                  </button>
                </div>
              </>
            )}

            {stage === "needsAuth" && (
              <>
                <p className="setup-kicker">ACCOUNT CONNECTION</p>
                <h1>Sign in where<br />you trust.</h1>
                <p>Groky opens xAI authentication in your browser and waits for approval. No code needs to be copied back into the app.</p>
                <div className="setup-actions">
                  <button className="primary-action" type="button" onClick={onLogin} disabled={Boolean(busyLabel)}>
                    {busyLabel ?? "Sign in to Grok"} {!busyLabel && <Icon name="arrow-right" size={15} />}
                  </button>
                  <span className="version-note">CLI {cleanVersion(status?.cliVersion ?? null)}</span>
                </div>
              </>
            )}

            {stage === "error" && (
              <>
                <p className="setup-kicker error-kicker">CONNECTION INTERRUPTED</p>
                <h1>Something broke<br />the handshake.</h1>
                <p>{error ?? status?.message ?? "Groky could not connect to Grok Build."}</p>
                <div className="setup-actions">
                  <button className="primary-action" type="button" onClick={onRetry}>
                    Try again <Icon name="refresh" size={15} />
                  </button>
                </div>
              </>
            )}
          </div>

          <aside className={`setup-side ${deviceAuthCode ? "has-auth-code" : ""}`}>
            {deviceAuthCode && (
              <div className="device-auth-code">
                <div className="device-auth-heading">
                  <span><i /> BROWSER VERIFICATION</span>
                  <button
                    className={`device-auth-copy ${copyState}`}
                    type="button"
                    aria-label={copyState === "copied" ? "Browser verification code copied" : copyState === "error" ? "Retry copying browser verification code" : "Copy browser verification code"}
                    onClick={() => void copyAuthCode()}
                  >
                    <Icon name={copyState === "copied" ? "check" : "copy"} size={12} />
                    <span aria-live="polite">{copyLabel}</span>
                  </button>
                </div>
                <strong role="status" aria-label={`Browser verification code ${deviceAuthCode}`}>{deviceAuthCode}</strong>
                <small>Make sure this code matches the browser before you continue.</small>
              </div>
            )}

            <ol className="setup-rail" aria-label="Setup progress">
              <SetupStep index="01" label="Grok CLI" detail={cliReady ? cleanVersion(status?.cliVersion ?? null) : "Required"} state={cliReady ? "done" : stage === "missingCli" ? "current" : "waiting"} />
              <SetupStep index="02" label="Authentication" detail={authReady ? "Connected" : deviceAuthCode ? "Match browser code" : "Browser approval"} state={authReady ? "done" : stage === "needsAuth" ? "current" : "waiting"} />
            </ol>
          </aside>

          {(error && stage !== "error") && <p className="setup-inline-error">{error}</p>}
        </section>
      </main>

      <footer className="onboarding-footer">
        <span><i className="privacy-dot" /> Credentials stay with the official Grok CLI</span>
        <span>ACP / LOCAL STDIO</span>
      </footer>
    </div>
  );
}

function SetupStep({ index, label, detail, state }: { index: string; label: string; detail: string; state: "done" | "current" | "waiting" }) {
  return (
    <li className={`setup-step ${state}`}>
      <span className="step-index">{state === "done" ? <Icon name="check" size={13} /> : index}</span>
      <span><strong>{label}</strong><small>{detail}</small></span>
      <i className="step-state" />
    </li>
  );
}

function AppUpdateNotice({
  update,
  phase,
  progress,
  error,
  taskRunning,
  onInstall,
  onDismiss,
}: {
  update: AppUpdateInfo;
  phase: AppUpdatePhase;
  progress: AppUpdateProgress | null;
  error: string | null;
  taskRunning: boolean;
  onInstall: () => void;
  onDismiss: () => void;
}) {
  const percentage = progress?.total
    ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
    : null;
  const installing = phase === "downloading";
  const progressLabel = progress?.stage === "installing"
    ? "Installing and preparing restart…"
    : percentage === null
      ? "Downloading signed update…"
      : `Downloading signed update… ${percentage}%`;

  return (
    <aside className={`app-update-notice ${phase}`} aria-live="polite" aria-label="Groky update">
      <div className="update-glyph"><Icon name="download" size={18} /></div>
      <div className="update-copy">
        <span>GROKY UPDATE</span>
        <strong>Version {update.version} is ready.</strong>
        {installing ? (
          <>
            <small>{progressLabel}</small>
            <div
              className={`update-progress ${percentage === null ? "indeterminate" : ""}`}
              role="progressbar"
              aria-label={progressLabel}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percentage ?? undefined}
            >
              <i style={percentage === null ? undefined : { width: `${percentage}%` }} />
            </div>
          </>
        ) : (
          <small>{phase === "error" ? error : update.body || `Update from ${update.currentVersion} to ${update.version}.`}</small>
        )}
      </div>
      <button
        className="update-install-button"
        type="button"
        disabled={taskRunning || installing}
        onClick={onInstall}
      >
        {installing ? "Updating…" : taskRunning ? "Finish current turn first" : "Update & restart"}
      </button>
      {!installing && (
        <button className="icon-button update-dismiss" type="button" aria-label="Dismiss update" onClick={onDismiss}>
          <Icon name="x" size={14} />
        </button>
      )}
    </aside>
  );
}

function ApprovalModeSelector({
  mode,
  busy,
  locked,
  onChange,
}: {
  mode: ApprovalMode;
  busy: boolean;
  locked: boolean;
  onChange: (mode: ApprovalMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const selected = approvalModeOption(mode);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (busy) setOpen(false);
  }, [busy]);

  return (
    <div className={`approval-control mode-${mode}`} ref={root}>
      <button
        className="approval-button"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Approval mode: ${selected.label}`}
        title={locked ? "Start a new session to choose another approval mode" : undefined}
        disabled={busy}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="shield-mark" aria-hidden="true">{selected.glyph}</span>
        <span>{selected.label}</span>
        <Icon name="chevron-down" size={13} />
      </button>

      {open && (
        <div className="approval-menu" role="listbox" aria-label="Session approval mode">
          <div className="approval-menu-heading">
            <span>APPROVAL MODE</span>
            <small>Choose when Grok asks</small>
          </div>
          <div className="approval-menu-options">
            {APPROVAL_MODES.map((option) => {
              const isSelected = option.id === mode;
              return (
                <button
                  className={`approval-option ${option.id === "alwaysApprove" ? "danger" : ""}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={locked || busy}
                  key={option.id}
                  onClick={() => {
                    setOpen(false);
                    onChange(option.id);
                  }}
                >
                  <span className="approval-option-glyph" aria-hidden="true">{option.glyph}</span>
                  <span className="approval-option-copy">
                    <span>
                      <strong>{option.label}</strong>
                      {option.tag && <em>{option.tag}</em>}
                    </span>
                    <small>{option.description}</small>
                  </span>
                  {isSelected && <Icon name="check" size={15} />}
                </button>
              );
            })}
          </div>
          <div className={`approval-menu-note ${locked ? "locked" : ""}`}>
            <span>{locked ? "Mode set for this session" : selected.shortDescription}</span>
            <small>{locked ? "Approval requests may still offer additional choices." : "The approval mode is applied when this session starts."}</small>
          </div>
        </div>
      )}
    </div>
  );
}

function ModelSelector({
  connected,
  models,
  busy,
  onLoad,
  onChange,
  onReasoningChange,
}: {
  connected: boolean;
  models: SessionModelState | null;
  busy: boolean;
  onLoad: () => Promise<boolean>;
  onChange: (modelId: string) => Promise<SessionModelState | null>;
  onReasoningChange: (reasoningEffort: string) => Promise<SessionModelState | null>;
}) {
  const [open, setOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<"model" | "reasoning" | null>(null);
  const [loading, setLoading] = useState(false);
  const [changingModelId, setChangingModelId] = useState<string | null>(null);
  const [changingReasoningEffort, setChangingReasoningEffort] = useState<string | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const selected = currentModel(models);
  const reasoningEffort = selected?._meta?.reasoningEffort;
  const reasoningEfforts = selected?._meta?.supportsReasoningEffort === false
    ? []
    : selected?._meta?.reasoningEfforts ?? [];
  const selectedReasoning = reasoningEfforts.find((effort) =>
    effort.id === reasoningEffort || effort.value === reasoningEffort
  );
  const reasoningLabel = selectedReasoning?.label.replace(/\s+Effort$/i, "") ?? reasoningEffort;
  const changing = changingModelId !== null || changingReasoningEffort !== null;

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (busy) setOpen(false);
  }, [busy]);

  async function toggleMenu() {
    if (open) {
      setOpen(false);
      return;
    }
    if (!connected) {
      setLoading(true);
      const loaded = await onLoad();
      setLoading(false);
      if (!loaded) return;
    }
    setActiveSection(null);
    setOpen(true);
  }

  async function selectModel(modelId: string) {
    if (modelId === models?.currentModelId) {
      setOpen(false);
      return;
    }
    setChangingModelId(modelId);
    const nextModels = await onChange(modelId);
    setChangingModelId(null);
    if (nextModels) setOpen(false);
  }

  async function selectReasoningEffort(effort: ReasoningEffortInfo) {
    if (effort.value === reasoningEffort || effort.id === reasoningEffort) {
      setOpen(false);
      return;
    }
    setChangingReasoningEffort(effort.value);
    const nextModels = await onReasoningChange(effort.value);
    setChangingReasoningEffort(null);
    if (nextModels) setOpen(false);
  }

  return (
    <div className="model-control" ref={root}>
      <button
        className="model-button"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Model: ${selected?.name ?? "Grok Build default"}${reasoningLabel ? `, reasoning: ${reasoningLabel}` : ""}`}
        disabled={busy || loading || changing}
        onClick={() => void toggleMenu()}
      >
        <span>{loading ? "Starting Grok Build…" : selected?.name ?? "Grok Build"}</span>
        <span className="reasoning">· {reasoningLabel ?? (connected ? "ACP" : "default")}</span>
        <Icon name="chevron-down" size={12} />
      </button>

      {open && (
        <div className="approval-menu model-menu" role="menu" aria-label="Grok Build model and reasoning settings">
          <div
            className="model-settings-item"
            role="none"
            onPointerLeave={() => setActiveSection((current) => current === "model" ? null : current)}
          >
            <button
              className={`model-settings-row ${activeSection === "model" ? "active" : ""}`}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={activeSection === "model"}
              disabled={!models || changing}
              onPointerEnter={() => setActiveSection("model")}
              onFocus={() => setActiveSection("model")}
              onClick={() => setActiveSection("model")}
            >
              <span>Model</span>
              <span className="model-settings-value">{selected?.name ?? "Grok Build"}</span>
              {models && <span className="model-settings-chevron" aria-hidden="true">›</span>}
            </button>

            {models && activeSection === "model" && (
              <div className="model-submenu" role="menu" aria-label="Session model">
                {models.availableModels.map((model) => {
                  const isSelected = model.modelId === models.currentModelId;
                  return (
                    <button
                      className="model-submenu-option"
                      type="button"
                      role="menuitemradio"
                      aria-checked={isSelected}
                      disabled={changing}
                      key={model.modelId}
                      onClick={() => void selectModel(model.modelId)}
                    >
                      <span>{changingModelId === model.modelId ? "Switching…" : model.name}</span>
                      {isSelected && <Icon name="check" size={14} />}
                    </button>
                  );
                })}
                {selected?.description && <div className="model-submenu-note">{selected.description}</div>}
              </div>
            )}
          </div>
          {reasoningEfforts.length > 0 && (
            <div
              className="model-settings-item"
              role="none"
              onPointerLeave={() => setActiveSection((current) => current === "reasoning" ? null : current)}
            >
              <button
                className={`model-settings-row ${activeSection === "reasoning" ? "active" : ""}`}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={activeSection === "reasoning"}
                disabled={changing}
                onPointerEnter={() => setActiveSection("reasoning")}
                onFocus={() => setActiveSection("reasoning")}
                onClick={() => setActiveSection("reasoning")}
              >
                <span>Reasoning</span>
                <span className="model-settings-value">{reasoningLabel ?? "Default"}</span>
                <span className="model-settings-chevron" aria-hidden="true">›</span>
              </button>

              {activeSection === "reasoning" && (
                <div className="model-submenu" role="menu" aria-label="Reasoning effort">
                  {reasoningEfforts.map((effort) => {
                    const isSelected = effort.id === reasoningEffort || effort.value === reasoningEffort;
                    return (
                      <button
                        className="model-submenu-option"
                        type="button"
                        role="menuitemradio"
                        aria-checked={isSelected}
                        disabled={changing}
                        key={effort.id}
                        onClick={() => void selectReasoningEffort(effort)}
                      >
                        <span>{changingReasoningEffort === effort.value ? "Changing…" : effort.label.replace(/\s+Effort$/i, "")}</span>
                        {isSelected && <Icon name="check" size={14} />}
                      </button>
                    );
                  })}
                  {selectedReasoning?.description && <div className="model-submenu-note">{selectedReasoning.description}</div>}
                </div>
              )}
            </div>
          )}
          {!models && (
            <div className="model-settings-note">This Grok Build session uses its default model.</div>
          )}
        </div>
      )}
    </div>
  );
}

function App() {
  const overlayTitlebar = usesOverlayTitlebar();
  const dragRegionProps = overlayTitlebar ? { "data-tauri-drag-region": "" } : {};
  const sidebarShortcutLabel = isMacOS() ? "⌘B" : "Ctrl+B";
  const [stage, setStage] = useState<OnboardingStage>("checking");
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [deviceAuthCode, setDeviceAuthCode] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [sessionHistory, setSessionHistory] = useState<PersistedSessionSummary[]>([]);
  const [workspaceHistory, setWorkspaceHistory] = useState<PersistedWorkspaceSummary[]>([]);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [showConnection, setShowConnection] = useState(false);
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [appUpdate, setAppUpdate] = useState<AppUpdateInfo | null>(null);
  const [updatePhase, setUpdatePhase] = useState<AppUpdatePhase>("idle");
  const [updateProgress, setUpdateProgress] = useState<AppUpdateProgress | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateCheckNotice, setUpdateCheckNotice] = useState<string | null>(null);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const [activeHistoryMessageId, setActiveHistoryMessageId] = useState<string | null>(null);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("ask");
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(storedSidebarCollapsed);
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(() => new Set());
  const [sidebarMenu, setSidebarMenu] = useState<SidebarMenu>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteConfirmation | null>(null);
  const [historyMutating, setHistoryMutating] = useState(false);
  const [nativeTitlebarHeight, setNativeTitlebarHeight] = useState<number | null>(null);
  const activeAssistantId = useRef<string | null>(null);
  const autoScrollEnabled = useRef(true);
  const conversation = useRef<HTMLElement | null>(null);
  const composer = useRef<HTMLFormElement | null>(null);
  const composerTextarea = useRef<HTMLTextAreaElement | null>(null);
  const updateCheckInFlight = useRef(false);
  const connectionTransitioning = useRef(false);
  const sidebarResizeStart = useRef<{ pointerX: number; width: number } | null>(null);

  const projectName = useMemo(() => workspaceName(connection?.workspace ?? workspace), [connection, workspace]);
  const messageHistory = useMemo(() => conversationTurnPreviews(messages), [messages]);
  const appUpdating = updatePhase === "downloading";
  const sidebarSessions: SidebarSessionSummary[] = sessionHistory.map((session) => ({
    ...session,
    running: running && connection?.sessionId === session.sessionId,
  }));
  const trackedWorkspacePaths = new Set(workspaceHistory.map((entry) => entry.path));
  const visibleSidebarSessions = sidebarSessions.filter((session) =>
    session.workspace === null || trackedWorkspacePaths.has(session.workspace)
  );
  const activeSidebarSessions = visibleSidebarSessions.filter((session) => !session.archived);
  const archivedSidebarSessions = visibleSidebarSessions.filter((session) => session.archived);
  const groupedSidebarSessions = groupSidebarSessions(activeSidebarSessions);
  const sessionsByWorkspace = new Map(groupedSidebarSessions.workspaceGroups.map((group) => [group.path, group.sessions]));
  const workspacePaths = workspaceHistory.map((entry) => entry.path);
  if (workspace && !workspacePaths.includes(workspace)) workspacePaths.unshift(workspace);
  const workspaceGroups: SidebarWorkspaceGroup[] = workspacePaths.map((path) => ({
    path,
    sessions: sessionsByWorkspace.get(path) ?? [],
  }));
  const sidebarActionsDisabled = running || appUpdating || stage === "connecting" || historyMutating;
  const sessionLocationEditable = connection === null && messages.length === 0 && !running;

  useEffect(() => {
    if (!overlayTitlebar) return;

    let disposed = false;
    let animationFrame = 0;
    const updateTitlebarHeight = () => {
      void invoke<number | null>("configure_native_titlebar")
        .then((height) => {
          if (!disposed && height !== null && height > 0 && height <= 96) {
            setNativeTitlebarHeight(height);
          }
        })
        .catch(() => undefined);
    };
    const scheduleTitlebarUpdate = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(updateTitlebarHeight);
    };

    updateTitlebarHeight();
    window.addEventListener("resize", scheduleTitlebarUpdate);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", scheduleTitlebarUpdate);
    };
  }, [overlayTitlebar]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {
      // Persistence is optional when storage is unavailable.
    }
  }, [sidebarWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed));
    } catch {
      // Persistence is optional when storage is unavailable.
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    const handleSidebarShortcut = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "b") return;
      event.preventDefault();
      setSidebarCollapsed((current) => !current);
      setShowConnection(false);
    };

    window.addEventListener("keydown", handleSidebarShortcut);
    return () => {
      window.removeEventListener("keydown", handleSidebarShortcut);
      document.body.classList.remove("is-resizing-sidebar");
    };
  }, []);

  useEffect(() => {
    if (!sidebarMenu) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[data-sidebar-menu-root]")) {
        setSidebarMenu(null);
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setSidebarMenu(null);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [sidebarMenu]);

  useEffect(() => {
    if (running || appUpdating || stage === "connecting" || historyMutating || sidebarCollapsed) {
      setSidebarMenu(null);
    }
  }, [appUpdating, historyMutating, running, sidebarCollapsed, stage]);

  useEffect(() => {
    if (!deleteConfirmation) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !historyMutating) setDeleteConfirmation(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deleteConfirmation, historyMutating]);

  function toggleSidebar() {
    if (!sidebarCollapsed) setShowConnection(false);
    setSidebarCollapsed((current) => !current);
  }

  function toggleWorkspaceGroup(path: string) {
    setSidebarMenu(null);
    setCollapsedWorkspaces((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || sidebarCollapsed) return;
    event.preventDefault();
    sidebarResizeStart.current = { pointerX: event.clientX, width: sidebarWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing-sidebar");
  }

  function resizeSidebar(event: ReactPointerEvent<HTMLDivElement>) {
    const start = sidebarResizeStart.current;
    if (!start) return;
    setSidebarWidth(clampSidebarWidth(start.width + event.clientX - start.pointerX));
  }

  function finishSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!sidebarResizeStart.current) return;
    sidebarResizeStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("is-resizing-sidebar");
  }

  function resizeSidebarWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 32 : 12;
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = sidebarWidth - step;
    if (event.key === "ArrowRight") nextWidth = sidebarWidth + step;
    if (event.key === "Home") nextWidth = MIN_SIDEBAR_WIDTH;
    if (event.key === "End") nextWidth = MAX_SIDEBAR_WIDTH;
    if (nextWidth === null) return;
    event.preventDefault();
    setSidebarWidth(clampSidebarWidth(nextWidth));
  }

  async function refreshSessionHistory() {
    if (!isTauri()) return;
    try {
      const [sessions, workspaces] = await Promise.all([
        invoke<PersistedSessionSummary[]>("grok_list_sessions"),
        invoke<PersistedWorkspaceSummary[]>("grok_list_workspaces"),
      ]);
      setSessionHistory(sessions);
      setWorkspaceHistory(workspaces);
    } catch (error) {
      setConnectionNotice(String(error));
    }
  }

  async function refreshStatus() {
    setSetupError(null);
    if (!isTauri()) {
      setStage("webOnly");
      return;
    }

    setStage("checking");
    try {
      const next = await invoke<OnboardingStatus>("grok_status");
      setStatus(next);
      if (next.stage === "connected") {
        setStage("ready");
      } else {
        setStage(next.stage);
      }
    } catch (error) {
      setSetupError(String(error));
      setStage("error");
    }
  }

  useEffect(() => {
    void refreshStatus();
    void refreshSessionHistory();
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void getVersion().then((version) => {
      if (!disposed) setAppVersion(version);
    }).catch(() => undefined);

    const updateTimer = window.setTimeout(() => {
      if (updateCheckInFlight.current) return;
      updateCheckInFlight.current = true;
      setUpdatePhase("checking");
      void invoke<AppUpdateInfo | null>("check_app_update")
        .then((next) => {
          if (disposed) return;
          setAppUpdate(next);
          setUpdateProgress(null);
          setUpdatePhase(next ? "available" : "idle");
        })
        .catch(() => {
          if (!disposed) setUpdatePhase("idle");
        })
        .finally(() => {
          updateCheckInFlight.current = false;
        });
    }, 1200);

    void listen<AppUpdateProgress>("groky://update-progress", ({ payload }) => {
      setUpdateProgress(payload);
      setUpdatePhase("downloading");
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });

    return () => {
      disposed = true;
      window.clearTimeout(updateTimer);
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    void Promise.all([
      listen<SessionUpdate>("grok://session-update", ({ payload }) => {
        const messageId = activeAssistantId.current;
        if (!messageId) return;
        setMessages((current) => current.map((message) => {
          if (message.id !== messageId) return message;
          if (payload.kind === "agent_message_chunk") {
            return { ...finishThought(message, Date.now()), text: message.text + (payload.text ?? "") };
          }
          if (payload.kind === "agent_thought_chunk") {
            return {
              ...message,
              thought: (message.thought ?? "") + (payload.text ?? ""),
              thoughtActive: true,
              thoughtStartedAt: message.thoughtActive ? message.thoughtStartedAt ?? Date.now() : Date.now(),
            };
          }
          if (payload.kind === "plan") {
            return { ...finishThought(message, Date.now()), plan: payload.entries ?? [] };
          }
          if (payload.kind === "tool_call" || payload.kind === "tool_call_update") {
            const id = payload.toolCallId ?? `tool-${message.tools?.length ?? 0}`;
            const tools = [...(message.tools ?? [])];
            const index = tools.findIndex((tool) => tool.id === id);
            const nextTool: ToolActivity = {
              id,
              title: payload.title ?? tools[index]?.title ?? "Working with a local tool",
              kind: payload.toolKind ?? tools[index]?.kind ?? undefined,
              status: payload.status ?? tools[index]?.status ?? "in_progress",
            };
            if (index >= 0) tools[index] = nextTool;
            else tools.push(nextTool);
            return { ...finishThought(message, Date.now()), tools };
          }
          return message;
        }));
      }),
      listen<PermissionRequest>("grok://permission-request", ({ payload }) => {
        const messageId = activeAssistantId.current;
        if (messageId) {
          const endedAt = Date.now();
          setMessages((current) => current.map((message) =>
            message.id === messageId ? finishThought(message, endedAt) : message
          ));
        }
        setPermission(payload);
      }),
      listen<ConnectionEvent>("grok://connection", ({ payload }) => {
        if (payload.status === "disconnected" && connection && !connectionTransitioning.current) {
          setConnectionNotice(payload.message ?? "Grok Build disconnected.");
        }
      }),
      listen<DeviceAuthCodeEvent>("grok://device-auth-code", ({ payload }) => {
        setDeviceAuthCode(payload.code);
      }),
    ]).then((items) => {
      if (disposed) items.forEach((unlisten) => unlisten());
      else unlisteners.push(...items);
    });

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [connection]);

  useLayoutEffect(() => {
    const container = conversation.current;
    if (!container) return;

    if (messages.length === 0) {
      autoScrollEnabled.current = true;
      setShowScrollToLatest(false);
      setActiveHistoryMessageId(null);
      return;
    }

    if (autoScrollEnabled.current) {
      container.scrollTop = container.scrollHeight;
      setShowScrollToLatest(false);
    } else {
      const hasContentBelow = container.scrollHeight - container.scrollTop - container.clientHeight > 2;
      setShowScrollToLatest(hasContentBelow);
    }

    updateActiveHistoryMessage(container);
  }, [messages, permission]);

  useLayoutEffect(() => {
    resizeTextareaToContent(composerTextarea.current);
  }, [draft, sidebarCollapsed, sidebarWidth, stage]);

  useLayoutEffect(() => {
    const composerElement = composer.current;
    const workspaceElement = composerElement?.parentElement;
    if (!composerElement || !workspaceElement) return;

    const updateComposerHeight = () => {
      workspaceElement.style.setProperty("--composer-height", `${composerElement.offsetHeight}px`);
    };
    updateComposerHeight();

    const observer = new ResizeObserver(updateComposerHeight);
    observer.observe(composerElement);
    return () => {
      observer.disconnect();
      workspaceElement.style.removeProperty("--composer-height");
    };
  }, [stage]);

  useEffect(() => {
    const handleWindowResize = () => resizeTextareaToContent(composerTextarea.current);
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, []);

  function handleConversationScroll() {
    const container = conversation.current;
    if (!container) return;

    const hasContentBelow = container.scrollHeight - container.scrollTop - container.clientHeight > 2;
    autoScrollEnabled.current = !hasContentBelow;
    setShowScrollToLatest(hasContentBelow);
    updateActiveHistoryMessage(container);
  }

  function updateActiveHistoryMessage(container: HTMLElement) {
    const messageElements = Array.from(
      container.querySelectorAll<HTMLElement>("[data-history-message-id]"),
    );
    if (messageElements.length === 0) {
      setActiveHistoryMessageId(null);
      return;
    }

    const containerBounds = container.getBoundingClientRect();
    const readingLine = containerBounds.top + Math.min(160, containerBounds.height * 0.28);
    let activeMessageId = messageElements[0].dataset.historyMessageId ?? null;

    messageElements.forEach((element) => {
      if (element.getBoundingClientRect().top <= readingLine) {
        activeMessageId = element.dataset.historyMessageId ?? activeMessageId;
      }
    });

    const atLatest = container.scrollHeight - container.scrollTop - container.clientHeight <= 2;
    if (atLatest) {
      activeMessageId = messageElements[messageElements.length - 1].dataset.historyMessageId ?? activeMessageId;
    }
    setActiveHistoryMessageId(activeMessageId);
  }

  function scrollToHistoryMessage(messageId: string) {
    const container = conversation.current;
    const target = Array.from(
      container?.querySelectorAll<HTMLElement>("[data-history-message-id]") ?? [],
    ).find((element) => element.dataset.historyMessageId === messageId);
    if (!container || !target) return;

    const containerBounds = container.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    const targetTop = container.scrollTop + targetBounds.top - containerBounds.top - 28;
    autoScrollEnabled.current = false;
    setActiveHistoryMessageId(messageId);
    container.scrollTo({
      top: Math.max(0, targetTop),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }

  function scrollToLatest() {
    const container = conversation.current;
    if (!container) return;

    autoScrollEnabled.current = true;
    container.scrollTop = container.scrollHeight;
    setShowScrollToLatest(false);
  }

  async function openInstallGuide() {
    try {
      await invoke("open_grok_install_guide");
    } catch (error) {
      setSetupError(String(error));
    }
  }

  async function checkForAppUpdate(manual: boolean) {
    if (updatePhase === "downloading" || updateCheckInFlight.current) return;
    updateCheckInFlight.current = true;
    setUpdatePhase("checking");
    setUpdateError(null);
    if (manual) setUpdateCheckNotice("Checking for updates…");

    try {
      const next = await invoke<AppUpdateInfo | null>("check_app_update");
      setAppUpdate(next);
      setUpdateProgress(null);
      setUpdatePhase(next ? "available" : "idle");
      if (manual) {
        setUpdateCheckNotice(next ? `Version ${next.version} is available.` : "Groky is up to date.");
      }
    } catch (error) {
      const message = String(error);
      setUpdateError(message);
      setUpdatePhase(appUpdate ? "error" : "idle");
      if (manual) setUpdateCheckNotice(message);
    } finally {
      updateCheckInFlight.current = false;
    }
  }

  async function installAppUpdate() {
    if (!appUpdate || running || updatePhase === "downloading") return;
    setUpdateError(null);
    setUpdateProgress({ stage: "downloading", downloaded: 0, total: null });
    setUpdatePhase("downloading");

    try {
      await invoke("install_app_update");
    } catch (error) {
      const message = String(error);
      setUpdateError(message);
      setUpdateCheckNotice(message);
      setUpdatePhase("error");
    }
  }

  function dismissAppUpdate() {
    setAppUpdate(null);
    setUpdateError(null);
    setUpdateProgress(null);
    setUpdatePhase("idle");
  }

  async function login() {
    setSetupError(null);
    setDeviceAuthCode(null);
    setBusyLabel("Waiting for approval…");
    try {
      await invoke("grok_login");
      setBusyLabel("Checking session…");
      await refreshStatus();
    } catch (error) {
      setSetupError(String(error));
    } finally {
      setBusyLabel(null);
      setDeviceAuthCode(null);
    }
  }

  async function chooseWorkspace() {
    setSetupError(null);
    setConnectionNotice(null);
    try {
      return await invoke<string | null>("choose_workspace");
    } catch (error) {
      setSetupError(String(error));
      return null;
    }
  }

  async function connect(
    targetWorkspace: string | null = workspace,
    clearConversation = false,
    targetApprovalMode: ApprovalMode = approvalMode,
  ) {
    setSetupError(null);
    setConnectionNotice(null);
    connectionTransitioning.current = true;
    setStage("connecting");
    try {
      const next = await invoke<Connection>("grok_connect", {
        workspace: targetWorkspace,
        approvalMode: targetApprovalMode,
      });
      setConnection(next);
      setWorkspace(next.workspace);
      setApprovalMode(next.approvalMode);
      setStatus((current) => current ? { ...current, stage: "connected", cliVersion: next.cliVersion } : current);
      setStage("connected");
      if (clearConversation) setMessages([]);
      await refreshSessionHistory();
      connectionTransitioning.current = false;
      return next;
    } catch (error) {
      const message = String(error);
      const authRequired = message.includes(AUTH_REQUIRED_ERROR);
      setSetupError(authRequired ? null : message);
      setConnection(null);
      setMessages([]);
      setStage(authRequired ? "needsAuth" : "ready");
      connectionTransitioning.current = false;
      return null;
    }
  }

  async function loadSession(session: PersistedSessionSummary) {
    setSidebarMenu(null);
    if (
      session.sessionId === connection?.sessionId
      || running
      || appUpdating
      || stage === "connecting"
    ) return;

    setShowConnection(false);
    setSetupError(null);
    setConnectionNotice(null);
    setPermission(null);
    setDraft("");
    activeAssistantId.current = null;
    connectionTransitioning.current = true;
    setStage("connecting");

    try {
      const loaded = await invoke<LoadSessionResult>("grok_load_session", {
        sessionId: session.sessionId,
      });
      setConnection(loaded.connection);
      setWorkspace(loaded.connection.workspace);
      setApprovalMode(loaded.connection.approvalMode);
      setMessages(messagesFromSessionReplay(loaded.connection.sessionId, loaded.updates));
      setStatus((current) => current ? {
        ...current,
        stage: "connected",
        cliVersion: loaded.connection.cliVersion,
      } : current);
      setStage("connected");
      await refreshSessionHistory();
      connectionTransitioning.current = false;
    } catch (error) {
      await invoke("grok_disconnect").catch(() => undefined);
      const message = String(error);
      const authRequired = message.includes(AUTH_REQUIRED_ERROR);
      setConnection(null);
      setMessages([]);
      setApprovalMode("ask");
      setSetupError(authRequired ? null : message);
      setStage(authRequired ? "needsAuth" : "ready");
      connectionTransitioning.current = false;
    }
  }

  async function chooseAndAddWorkspace(): Promise<string | null> {
    if (sidebarActionsDisabled) return null;
    const selected = await chooseWorkspace();
    if (!selected) return null;

    try {
      const added = await invoke<PersistedWorkspaceSummary>("grok_add_workspace", {
        workspace: selected,
      });
      setWorkspaceHistory((current) => current.some((entry) => entry.path === added.path)
        ? current
        : [...current, added]);
      setCollapsedWorkspaces((current) => {
        const next = new Set(current);
        next.delete(added.path);
        return next;
      });
      return added.path;
    } catch (error) {
      setConnectionNotice(String(error));
      return null;
    }
  }

  async function removeWorkspace(path: string) {
    if (sidebarActionsDisabled) return;
    const removesCurrentLocation = workspace === path;
    const disconnectsActiveSession = connection?.workspace === path;
    setSidebarMenu(null);
    setHistoryMutating(true);
    setConnectionNotice(null);

    try {
      const workspaces = await invoke<PersistedWorkspaceSummary[]>("grok_remove_workspace", {
        workspace: path,
      });
      if (disconnectsActiveSession) {
        connectionTransitioning.current = true;
        await invoke("grok_disconnect").catch(() => undefined);
        connectionTransitioning.current = false;
        setConnection(null);
        setMessages([]);
        setPermission(null);
        setApprovalMode("ask");
        setStage("ready");
      }
      if (removesCurrentLocation) setWorkspace(null);
      setWorkspaceHistory(workspaces);
      setCollapsedWorkspaces((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      setConnectionNotice(`${workspaceName(path)} was removed from Groky. The folder and session history were kept.`);
    } catch (error) {
      connectionTransitioning.current = false;
      setConnectionNotice(String(error));
    } finally {
      setHistoryMutating(false);
    }
  }

  async function mutateSessionHistory(
    action: SessionHistoryAction,
    target: { sessionId?: string; workspace?: string },
  ) {
    if (sidebarActionsDisabled) return;
    const affectsActive = connection !== null && (
      target.sessionId === connection.sessionId
      || (target.workspace !== undefined && target.workspace === connection.workspace)
    );
    setSidebarMenu(null);
    setHistoryMutating(true);
    setConnectionNotice(null);
    try {
      const sessions = await invoke<PersistedSessionSummary[]>("grok_mutate_sessions", {
        action,
        sessionId: target.sessionId,
        workspace: target.workspace,
      });
      setSessionHistory(sessions);
      if (affectsActive && action !== "restore") {
        setConnection(null);
        setMessages([]);
        setPermission(null);
        setApprovalMode("ask");
        setStage("ready");
      }
    } catch (error) {
      setConnectionNotice(String(error));
    } finally {
      setHistoryMutating(false);
    }
  }

  function requestSessionDelete(session: PersistedSessionSummary) {
    setSidebarMenu(null);
    setDeleteConfirmation({
      sessionId: session.sessionId,
      title: "Delete session?",
      description: `“${session.title}” will be removed from Groky history. This cannot be undone.`,
    });
  }

  function requestWorkspaceDelete(path: string) {
    const count = sessionHistory.filter((session) => session.workspace === path).length;
    setSidebarMenu(null);
    setDeleteConfirmation({
      workspace: path,
      title: `Delete all sessions in ${workspaceName(path)}?`,
      description: `${count} ${count === 1 ? "session" : "sessions"} will be removed from Groky history. This cannot be undone.`,
    });
  }

  async function confirmDelete() {
    const target = deleteConfirmation;
    if (!target) return;
    setDeleteConfirmation(null);
    await mutateSessionHistory("delete", {
      sessionId: target.sessionId,
      workspace: target.workspace,
    });
  }

  async function revealWorkingDirectory() {
    setConnectionNotice(null);
    try {
      await invoke("reveal_working_directory");
    } catch (error) {
      setConnectionNotice(String(error));
    }
  }

  function selectPendingSessionLocation(targetWorkspace: string | null) {
    if (!sessionLocationEditable) return;
    setWorkspace(targetWorkspace);
    if (targetWorkspace) {
      setCollapsedWorkspaces((current) => {
        const next = new Set(current);
        next.delete(targetWorkspace);
        return next;
      });
    }
  }

  async function startNewTask(targetWorkspace: string | null = workspace) {
    if (sidebarActionsDisabled) return;
    const nextMode: ApprovalMode = "ask";
    setSidebarMenu(null);
    if (connection) {
      connectionTransitioning.current = true;
      await invoke("grok_disconnect").catch(() => undefined);
      connectionTransitioning.current = false;
    }
    if (targetWorkspace) {
      setCollapsedWorkspaces((current) => {
        const next = new Set(current);
        next.delete(targetWorkspace);
        return next;
      });
    }
    setDraft("");
    setMessages([]);
    setPermission(null);
    setApprovalMode(nextMode);
    setSetupError(null);
    setConnectionNotice(null);
    setConnection(null);
    setWorkspace(targetWorkspace);
    setStage("ready");
  }

  async function changeApprovalMode(nextMode: ApprovalMode) {
    if (nextMode === approvalMode || running || appUpdating || stage === "connecting" || messages.length > 0) return;
    setApprovalMode(nextMode);
    if (connection) await connect(workspace, false, nextMode);
  }

  async function loadModels() {
    const activeConnection = connection ?? await connect(workspace);
    return activeConnection !== null;
  }

  async function changeModel(modelId: string) {
    setConnectionNotice(null);
    try {
      const models = await invoke<SessionModelState>("grok_set_model", { modelId });
      setConnection((active) => active ? { ...active, models } : active);
      return models;
    } catch (error) {
      setConnectionNotice(String(error));
      return null;
    }
  }

  async function changeReasoningEffort(reasoningEffort: string) {
    setConnectionNotice(null);
    try {
      const models = await invoke<SessionModelState>("grok_set_reasoning_effort", { reasoningEffort });
      setConnection((active) => active ? { ...active, models } : active);
      return models;
    } catch (error) {
      setConnectionNotice(String(error));
      return null;
    }
  }

  async function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = draft.trim();
    if (!prompt || running || appUpdating || stage === "connecting") return;

    const activeConnection = connection ?? await connect(workspace);
    if (!activeConnection) return;

    setSessionHistory((current) => current
      .map((session) => session.sessionId === activeConnection.sessionId
        ? {
            ...session,
            title: session.title === "New Grok session" ? titleFromPrompt(prompt) : session.title,
            updatedAt: Date.now(),
          }
        : session)
      .sort((left, right) => right.updatedAt - left.updatedAt));

    const userMessage: ConversationMessage = {
      id: makeMessageId("user"),
      role: "user",
      text: prompt,
    };
    const assistantMessage: ConversationMessage = {
      id: makeMessageId("assistant"),
      role: "assistant",
      text: "",
      startedAt: Date.now(),
      state: "streaming",
    };
    activeAssistantId.current = assistantMessage.id;
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setDraft("");
    setRunning(true);
    setPermission(null);

    try {
      const result = await invoke<PromptResult>("grok_prompt", { prompt });
      const endedAt = Date.now();
      setMessages((current) => current.map((message) =>
        message.id === assistantMessage.id
          ? {
              ...finishRun(message, endedAt),
              text: result.text || message.text,
              thought: result.thought || message.thought,
              state: "complete",
            }
          : message
      ));
    } catch (error) {
      const endedAt = Date.now();
      setMessages((current) => current.map((message) =>
        message.id === assistantMessage.id
          ? { ...finishRun(message, endedAt), state: "error", error: String(error) }
          : message
      ));
    } finally {
      setRunning(false);
      setPermission(null);
      activeAssistantId.current = null;
      void refreshSessionHistory();
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  async function cancelRun() {
    try {
      await invoke("grok_cancel");
      const messageId = activeAssistantId.current;
      const endedAt = Date.now();
      setMessages((current) => current.map((message) =>
        message.id === messageId ? { ...finishRun(message, endedAt), state: "cancelled" } : message
      ));
    } catch (error) {
      setConnectionNotice(String(error));
    }
  }

  async function respondToPermission(optionId: string | null) {
    if (!permission) return;
    const current = permission;
    const selectedOption = current.options.find((option) => option.optionId === optionId);
    setPermission(null);
    try {
      await invoke("grok_respond_permission", { requestId: current.requestId, optionId });
      if (enablesAlwaysApprove(selectedOption)) {
        setApprovalMode("alwaysApprove");
        setConnection((active) => active ? { ...active, approvalMode: "alwaysApprove" } : active);
      }
    } catch (error) {
      setConnectionNotice(String(error));
    }
  }

  async function signOut() {
    setShowConnection(false);
    setConnection(null);
    setMessages([]);
    setApprovalMode("ask");
    setStage("checking");
    try {
      await invoke("grok_logout");
      await refreshStatus();
    } catch (error) {
      setSetupError(String(error));
      setStage("error");
    }
  }

  async function disconnect() {
    setShowConnection(false);
    try {
      await invoke("grok_disconnect");
    } finally {
      setConnection(null);
      setMessages([]);
      setApprovalMode("ask");
      setStage("ready");
    }
  }

  const authenticated = ["ready", "connecting", "connected"].includes(stage);
  const appNotice = connectionNotice ?? setupError;
  const updateNotice = appUpdate ? (
    <AppUpdateNotice
      update={appUpdate}
      phase={updatePhase}
      progress={updateProgress}
      error={updateError}
      taskRunning={running}
      onInstall={() => void installAppUpdate()}
      onDismiss={dismissAppUpdate}
    />
  ) : null;

  if (!authenticated) {
    return (
      <>
        <Onboarding
        stage={stage}
        status={status}
        busyLabel={busyLabel}
        deviceAuthCode={deviceAuthCode}
        error={setupError}
          titlebarHeight={nativeTitlebarHeight}
          onRetry={() => void refreshStatus()}
          onOpenInstallGuide={() => void openInstallGuide()}
          onLogin={() => void login()}
        />
        {updateNotice}
      </>
    );
  }

  return (
    <>
      <div
        className={`app-shell ${overlayTitlebar ? "has-overlay-titlebar" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
        style={{
          "--sidebar-width": `${sidebarWidth}px`,
          ...(overlayTitlebar && nativeTitlebarHeight !== null
            ? { "--app-header-height": `${nativeTitlebarHeight}px` }
            : {}),
        } as CSSProperties}
      >
      <aside className="sidebar">
        <div className="window-nav" {...dragRegionProps}>
          <button className="icon-button sidebar-toggle" type="button" aria-label="Hide sidebar" title={`Hide sidebar (${sidebarShortcutLabel})`} onClick={toggleSidebar}><Icon name="panel" /></button>
        </div>

        <div className="brand-row">
          <Brand />
          <button className="icon-button dimmed" type="button" aria-label="Search" disabled><Icon name="search" size={18} /></button>
        </div>

        <nav className="primary-nav" aria-label="Primary">
          <button type="button" onClick={() => void startNewTask()} disabled={sidebarActionsDisabled}>
            <Icon name="compose" /><span>New session</span>
          </button>
        </nav>

        <div className="project-scroll">
          <div className="project-section-header">
            <span>Working directories</span>
            <button
              className="project-add-workspace"
              type="button"
              aria-label="Add working directory"
              title="Add working directory"
              disabled={sidebarActionsDisabled}
              onClick={() => void chooseAndAddWorkspace()}
            >
              <Icon name="plus" size={15} />
            </button>
          </div>

          {workspaceGroups.map((group) => {
            const expanded = !collapsedWorkspaces.has(group.path);
            const workspaceMenuOpen = sidebarMenu?.kind === "workspace" && sidebarMenu.path === group.path;
            const allSessionCount = sessionHistory.filter((session) => session.workspace === group.path).length;
            return (
              <section className="project-group" key={group.path}>
                <div
                  className={`project-heading-row ${workspaceMenuOpen ? "actions-visible" : ""}`}
                  data-open={expanded}
                  data-sidebar-menu-root
                >
                  <button
                    className="project-heading"
                    type="button"
                    aria-expanded={expanded}
                    title={group.path}
                    onClick={() => toggleWorkspaceGroup(group.path)}
                  >
                    <Icon name={expanded ? "folder-open" : "folder"} />
                    <span>{workspaceName(group.path)}</span>
                  </button>
                  <div className="project-row-actions">
                    <button
                      className="project-more"
                      type="button"
                      aria-label={`Actions for ${workspaceName(group.path)}`}
                      aria-haspopup="menu"
                      aria-expanded={workspaceMenuOpen}
                      disabled={sidebarActionsDisabled}
                      onClick={() => setSidebarMenu((current) =>
                        current?.kind === "workspace" && current.path === group.path
                          ? null
                          : { kind: "workspace", path: group.path }
                      )}
                    >
                      <Icon name="dots" size={15} />
                    </button>
                    <button
                      className="project-new-session"
                      type="button"
                      aria-label={`New session in ${workspaceName(group.path)}`}
                      title={`New session in ${workspaceName(group.path)}`}
                      disabled={sidebarActionsDisabled}
                      onClick={() => void startNewTask(group.path)}
                    >
                      <Icon name="plus" size={15} />
                    </button>
                  </div>
                  {workspaceMenuOpen && (
                    <div className="sidebar-context-menu workspace-context-menu" role="menu" aria-label={`Actions for ${workspaceName(group.path)}`}>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={group.sessions.length === 0}
                        onClick={() => void mutateSessionHistory("archive", { workspace: group.path })}
                      >
                        <Icon name="archive" size={14} />
                        <span>Archive all sessions</span>
                      </button>
                      <button
                        className="danger-menu-item"
                        type="button"
                        role="menuitem"
                        disabled={allSessionCount === 0}
                        onClick={() => requestWorkspaceDelete(group.path)}
                      >
                        <Icon name="trash" size={14} />
                        <span>Delete all sessions</span>
                      </button>
                      <button
                        className="remove-workspace-menu-item"
                        type="button"
                        role="menuitem"
                        onClick={() => void removeWorkspace(group.path)}
                      >
                        <Icon name="folder-x" size={14} />
                        <span>Remove from Groky</span>
                      </button>
                    </div>
                  )}
                </div>
                <div className={`project-session-reveal ${expanded ? "is-open" : ""}`} aria-hidden={!expanded} inert={!expanded}>
                  <div className="project-session-reveal-inner">
                    {group.sessions.length > 0 ? (
                      <div className="task-list" aria-label={`Sessions in ${workspaceName(group.path)}`}>
                        {group.sessions.map((session) => (
                          <SidebarSessionRow
                            key={session.sessionId}
                            session={session}
                            selected={connection?.sessionId === session.sessionId}
                            disabled={sidebarActionsDisabled}
                            menuOpen={sidebarMenu?.kind === "session" && sidebarMenu.sessionId === session.sessionId}
                            onSelect={() => void loadSession(session)}
                            onToggleMenu={() => setSidebarMenu((current) =>
                              current?.kind === "session" && current.sessionId === session.sessionId
                                ? null
                                : { kind: "session", sessionId: session.sessionId }
                            )}
                            onArchive={() => void mutateSessionHistory("archive", { sessionId: session.sessionId })}
                            onRestore={() => void mutateSessionHistory("restore", { sessionId: session.sessionId })}
                            onDelete={() => requestSessionDelete(session)}
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="project-empty-state">No sessions yet</p>
                    )}
                  </div>
                </div>
              </section>
            );
          })}

          {groupedSidebarSessions.ungrouped.length > 0 && (
            <section className="unassigned-tasks">
              <p className="section-label">Standalone sessions</p>
              <div className="task-list ungrouped-task-list" aria-label="Standalone sessions">
                {groupedSidebarSessions.ungrouped.map((session) => (
                  <SidebarSessionRow
                    key={session.sessionId}
                    session={session}
                    selected={connection?.sessionId === session.sessionId}
                    disabled={sidebarActionsDisabled}
                    menuOpen={sidebarMenu?.kind === "session" && sidebarMenu.sessionId === session.sessionId}
                    onSelect={() => void loadSession(session)}
                    onToggleMenu={() => setSidebarMenu((current) =>
                      current?.kind === "session" && current.sessionId === session.sessionId
                        ? null
                        : { kind: "session", sessionId: session.sessionId }
                    )}
                    onArchive={() => void mutateSessionHistory("archive", { sessionId: session.sessionId })}
                    onRestore={() => void mutateSessionHistory("restore", { sessionId: session.sessionId })}
                    onDelete={() => requestSessionDelete(session)}
                  />
                ))}
              </div>
            </section>
          )}

          {archivedSidebarSessions.length > 0 && (
            <section className="archived-sessions">
              <button
                className="archived-heading"
                type="button"
                aria-expanded={archivedOpen}
                onClick={() => {
                  setSidebarMenu(null);
                  setArchivedOpen((current) => !current);
                }}
              >
                <Icon name="archive" size={14} />
                <span>Archived</span>
                <small>{archivedSidebarSessions.length}</small>
              </button>
              <div className={`archived-session-reveal ${archivedOpen ? "is-open" : ""}`} aria-hidden={!archivedOpen} inert={!archivedOpen}>
                <div className="project-session-reveal-inner">
                  <div className="task-list archived-task-list" aria-label="Archived sessions">
                    {archivedSidebarSessions.map((session) => (
                      <SidebarSessionRow
                        key={session.sessionId}
                        session={session}
                        selected={false}
                        disabled={sidebarActionsDisabled}
                        subtitle={session.workspace ? workspaceName(session.workspace) : "Standalone"}
                        menuOpen={sidebarMenu?.kind === "session" && sidebarMenu.sessionId === session.sessionId}
                        onSelect={() => void mutateSessionHistory("restore", { sessionId: session.sessionId })}
                        onToggleMenu={() => setSidebarMenu((current) =>
                          current?.kind === "session" && current.sessionId === session.sessionId
                            ? null
                            : { kind: "session", sessionId: session.sessionId }
                        )}
                        onArchive={() => void mutateSessionHistory("archive", { sessionId: session.sessionId })}
                        onRestore={() => void mutateSessionHistory("restore", { sessionId: session.sessionId })}
                        onDelete={() => requestSessionDelete(session)}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </section>
          )}
        </div>

        <button className="profile-row" type="button" onClick={() => setShowConnection((current) => !current)}>
          <span className="avatar">G</span>
          <span className="profile-copy"><strong>Grok Build</strong><small>{cleanVersion(connection?.cliVersion ?? status?.cliVersion ?? null)}</small></span>
          <span className={`connection-pill ${connection ? "" : "idle"}`}>{connection ? "live" : "signed in"}</span>
        </button>

        {showConnection && (
          <div className="connection-popover">
            <div className="popover-heading"><span>LOCAL CONNECTION</span><button className="icon-button" type="button" onClick={() => setShowConnection(false)}><Icon name="x" size={15} /></button></div>
            <dl>
              <div><dt>Groky</dt><dd>{appVersion ? `Version ${appVersion}` : "Version unavailable"}</dd></div>
              <div><dt>Engine</dt><dd>{connection?.cliVersion ?? status?.cliVersion ?? "Grok Build"}</dd></div>
              <div><dt>Account</dt><dd>Signed in</dd></div>
              {connection && <div><dt>Approvals</dt><dd>{approvalModeOption(connection.approvalMode).label}</dd></div>}
              {connection && <div><dt>Model</dt><dd>{currentModel(connection.models)?.name ?? "Grok Build default"}</dd></div>}
              {connection && <div><dt>{connection.workspace ? "Working directory" : "Session directory"}</dt><dd title={connection.workingDirectory}>{connection.workingDirectory}</dd></div>}
              {connection && <div><dt>Transport</dt><dd>ACP stdio</dd></div>}
            </dl>
            <div className="popover-update">
              <button type="button" onClick={() => void checkForAppUpdate(true)} disabled={updatePhase === "checking" || updatePhase === "downloading"}>
                <Icon name="refresh" size={13} />
                {updatePhase === "checking" ? "Checking…" : "Check for updates"}
              </button>
              {updateCheckNotice && <small aria-live="polite">{updateCheckNotice}</small>}
            </div>
            <div className="popover-actions">
              {connection && <button type="button" onClick={() => void revealWorkingDirectory()}><Icon name="external-link" size={14} /> Open folder</button>}
              {connection && <button type="button" onClick={() => void disconnect()}>Disconnect</button>}
              <button className="danger-action" type="button" onClick={() => void signOut()}><Icon name="logout" size={14} /> Sign out</button>
            </div>
          </div>
        )}
      </aside>

      {!sidebarCollapsed && (
        <div
          className="sidebar-resizer"
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={Math.round(sidebarWidth)}
          tabIndex={0}
          onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
          onKeyDown={resizeSidebarWithKeyboard}
          onPointerDown={startSidebarResize}
          onPointerMove={resizeSidebar}
          onPointerUp={finishSidebarResize}
          onPointerCancel={finishSidebarResize}
        />
      )}

      <main className="workspace">
        <header className="taskbar" {...dragRegionProps}>
          <div className="taskbar-leading">
            {sidebarCollapsed && (
              <button className="icon-button sidebar-restore" type="button" aria-label="Show sidebar" title={`Show sidebar (${sidebarShortcutLabel})`} onClick={toggleSidebar}><Icon name="panel" /></button>
            )}
            <div className="task-title workspace-context" title={workspace ?? undefined}>
              <Icon name={workspace ? "folder" : "compose"} /><strong>{workspace ? projectName : "Standalone session"}</strong>
            </div>
          </div>
          <div className="task-actions">
            <span className={`agent-state ${running ? "working" : ""}`}><span className="live-dot" />{running ? "Grok is working" : connection ? "ACP connected" : stage === "connecting" ? "Connecting" : "Signed in"}</span>
            {connection && <span className="branch-button"><Icon name="branch" /><span>local</span></span>}
            <button className="icon-button" type="button" aria-label="Connection settings" onClick={() => setShowConnection((current) => !current)}><Icon name="sliders" /></button>
          </div>
        </header>

        {appNotice && (
          <div className="connection-banner" role="alert">
            <span>{appNotice}</span>
            {workspace && <button type="button" onClick={() => void connect()}>Reconnect</button>}
            <button className="icon-button" type="button" aria-label="Dismiss" onClick={() => { setConnectionNotice(null); setSetupError(null); }}><Icon name="x" size={15} /></button>
          </div>
        )}

        <section
          id="task-conversation"
          ref={conversation}
          className={`conversation ${messages.length === 0 ? "empty" : ""}`}
          aria-label="Session conversation"
          onScroll={handleConversationScroll}
        >
          <div className="conversation-inner">
            {messages.length === 0 ? (
              <div className="empty-conversation">
                <span className="empty-orbit"><i /><i /></span>
                <p className="message-kicker">GROK BUILD / READY</p>
                <h1>What should we<br />make happen?</h1>
                <p>{workspace ? "Ask about the codebase, request a change, or start with a review." : "Start a standalone session, or choose an existing folder when you want Grok to work with a codebase."}</p>
                <div className="suggestion-row">
                  {["Explain this codebase", "Suggest the next improvement", "Review the current changes"].map((suggestion) => (
                    <button key={suggestion} type="button" onClick={() => setDraft(suggestion)}>{suggestion}</button>
                  ))}
                </div>
              </div>
            ) : messages.map((message) => (
              <ConversationItem key={message.id} message={message} />
            ))}

            {permission && (
              <PermissionCard permission={permission} onRespond={(optionId) => void respondToPermission(optionId)} />
            )}
          </div>
        </section>

        <MessageHistoryNav
          turns={messageHistory}
          activeId={activeHistoryMessageId}
          onNavigate={scrollToHistoryMessage}
        />

        {showScrollToLatest && (
          <button
            className="scroll-to-latest"
            type="button"
            aria-label="Scroll to latest message"
            aria-controls="task-conversation"
            onClick={scrollToLatest}
          >
            <Icon name="arrow-down" size={14} />
            <span>Latest</span>
          </button>
        )}

        <form ref={composer} className={`composer approval-mode-${approvalMode} ${running ? "is-running" : ""}`} onSubmit={submitTask}>
          {sessionLocationEditable && (
            <div className="composer-session-context">
              <SessionLocationSelector
                value={workspace}
                workspaces={workspaceGroups.map((group) => group.path)}
                disabled={sidebarActionsDisabled}
                onChange={selectPendingSessionLocation}
                onAddWorkspace={chooseAndAddWorkspace}
              />
              <span className="session-location-hint">Change until the first message</span>
            </div>
          )}
          <div className="prompt-row">
            <span className="prompt-symbol" aria-hidden="true">❯</span>
            <textarea
              ref={composerTextarea}
              aria-label="Session prompt"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={appUpdating ? "Groky is installing an update…" : running ? "Grok is working…" : stage === "connecting" ? "Starting Grok Build…" : "Ask Groky to build, debug, or review"}
              rows={2}
              disabled={running || appUpdating || stage === "connecting"}
            />
          </div>
          <div className="composer-toolbar">
            <ApprovalModeSelector
              mode={approvalMode}
              busy={running || appUpdating || stage === "connecting"}
              locked={messages.length > 0}
              onChange={(nextMode) => void changeApprovalMode(nextMode)}
            />
            {!sessionLocationEditable && (
              <span className="local-chip"><span className="live-dot" />{workspace ? "cwd" : "standalone"}</span>
            )}
            <span className="toolbar-spacer" />
            <ModelSelector
              connected={connection !== null}
              models={connection?.models ?? null}
              busy={running || appUpdating || stage === "connecting"}
              onLoad={loadModels}
              onChange={changeModel}
              onReasoningChange={changeReasoningEffort}
            />
            {running ? (
              <button className="send-button stop-button" type="button" aria-label="Stop" onClick={() => void cancelRun()}><Icon name="stop" size={15} /></button>
            ) : (
              <button className="send-button" type="submit" aria-label="Send" disabled={!draft.trim() || appUpdating || stage === "connecting"}><Icon name="arrow-up" size={17} /></button>
            )}
          </div>
        </form>
      </main>
      </div>
      {deleteConfirmation && (
        <div
          className="history-confirm-backdrop"
          role="presentation"
          onPointerDown={() => {
            if (!historyMutating) setDeleteConfirmation(null);
          }}
        >
          <div
            className="history-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="history-confirm-title"
            aria-describedby="history-confirm-description"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <span className="history-confirm-icon"><Icon name="trash" size={17} /></span>
            <div className="history-confirm-copy">
              <h2 id="history-confirm-title">{deleteConfirmation.title}</h2>
              <p id="history-confirm-description">{deleteConfirmation.description}</p>
            </div>
            <div className="history-confirm-actions">
              <button type="button" disabled={historyMutating} onClick={() => setDeleteConfirmation(null)}>Cancel</button>
              <button className="danger-confirm" type="button" disabled={historyMutating} onClick={() => void confirmDelete()}>
                {historyMutating ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
      {updateNotice}
    </>
  );
}

function ThoughtBlock({ thought, active, elapsedMs }: { thought: string; active: boolean; elapsedMs?: number }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const label = active
    ? "Thinking…"
    : elapsedMs === undefined
      ? "Thought"
      : `Thought for ${formatThoughtDuration(elapsedMs)}`;

  useEffect(() => {
    setOpen(active);
  }, [active]);

  return (
    <div className="thought-block" data-open={open}>
      <button
        className="thought-heading"
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="thought-label"><Icon name="chevron-down" size={13} /><span>{label}</span></span>
      </button>
      <div className="thought-content" id={contentId} aria-hidden={!open}>
        <div><p>{thought}</p></div>
      </div>
    </div>
  );
}

function ConversationItem({ message }: { message: ConversationMessage }) {
  if (message.role === "user") {
    return (
      <div className="user-message" data-history-message-id={message.id}>
        <span className="message-kicker">REQUEST</span>
        {message.text}
      </div>
    );
  }

  const duration = message.elapsedMs === undefined ? null : formatDuration(message.elapsedMs);
  const runStatus = message.state === "streaming"
    ? "Working…"
    : message.state === "cancelled"
      ? duration ? `Turn cancelled by user in ${duration}.` : "Turn cancelled by user."
      : message.state === "error"
        ? duration ? `Turn failed in ${duration}.` : "Turn failed."
        : duration ? `Worked for ${duration}.` : "Turn completed.";

  return (
    <article className={`assistant-turn ${message.state ?? "complete"}`}>
      <div className="run-heading">
        <span className="run-diamond">◆</span>
        <span>{runStatus}</span>
        <span className="run-line" />
      </div>

      {message.thought && (
        <ThoughtBlock
          thought={message.thought}
          active={message.thoughtActive === true}
          elapsedMs={message.thoughtElapsedMs}
        />
      )}

      {message.plan && message.plan.length > 0 && (
        <div className="plan-block">
          <span className="message-kicker">PLAN</span>
          {message.plan.map((entry, index) => (
            <div className="plan-row" key={`${entry.content}-${index}`}><i className={entry.status} />{entry.content}</div>
          ))}
        </div>
      )}

      {message.tools?.map((tool) => (
        <div className="activity-row" key={tool.id}>
          <span className="activity-icon">{tool.status === "completed" ? <Icon name="check" size={13} /> : <Icon name="terminal" size={13} />}</span>
          <span>{tool.title}</span>
          <span className="activity-detail">{tool.status?.replace(/_/g, " ") ?? tool.kind ?? "running"}</span>
        </div>
      ))}

      {message.text && <div className="response-copy">{message.text}</div>}
      {message.state === "streaming" && !message.text && <div className="response-skeleton"><i /><i /><i /></div>}
      {message.error && <p className="message-error">{message.error}</p>}
    </article>
  );
}

function permissionOptionClass(kind: string) {
  switch (kind) {
    case "allow_once":
      return "allow-once";
    case "allow_always":
      return "allow-always";
    case "reject_always":
      return "reject reject-always";
    case "reject_once":
      return "reject";
    default:
      return kind.includes("reject") ? "reject" : "allow-once";
  }
}

function PermissionCard({ permission, onRespond }: { permission: PermissionRequest; onRespond: (optionId: string | null) => void }) {
  const hasRejectOption = permission.options.some((option) => option.kind.startsWith("reject"));

  return (
    <aside className="permission-card" aria-live="assertive">
      <div className="permission-glyph">!</div>
      <div className="permission-copy">
        <span className="message-kicker">APPROVAL REQUIRED</span>
        <strong>{permission.title}</strong>
        <small>{permission.toolKind?.replace(/_/g, " ") ?? "Local tool action"}</small>
        <div className="permission-actions">
          {permission.options.map((option) => (
            <button
              className={permissionOptionClass(option.kind)}
              type="button"
              key={option.optionId}
              onClick={() => onRespond(option.optionId)}
            >
              {option.name}
            </button>
          ))}
          {!hasRejectOption && (
            <button className="reject" type="button" onClick={() => onRespond(null)}>Cancel request</button>
          )}
        </div>
      </div>
    </aside>
  );
}

export default App;
