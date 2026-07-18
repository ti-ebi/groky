import {
  useCallback,
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
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "@fontsource-variable/sora/index.css";
import "./App.css";
import { MarkdownContent } from "./MarkdownContent";
import { GlobalSearchDialog } from "./GlobalSearchDialog";
import { TerminalPanel } from "./TerminalPanel";
import {
  combineTimings,
  elapsedForTiming,
  type EventTiming,
} from "./timing";
import {
  addFallbackThought,
  applySessionUpdateToMessage,
  finishRun,
  isActiveToolStatus,
  makeMessageId,
  reconcileFallbackResponse,
  sessionReplayProjection,
  stateFromStopReason,
  terminalToolStatus,
} from "./session/projection";
import type {
  ApprovalMode,
  AvailableCommand,
  Connection,
  ConversationMessage,
  ConversationState,
  FileAttachment,
  LoadSessionResult,
  PermissionOption,
  PermissionRequest,
  PlanEntry,
  PromptResult,
  ReasoningEffortInfo,
  SessionConfigOption,
  SessionModelState,
  SessionReplayProjection,
  SessionUpdate,
  SessionUsage,
  SessionViewState,
  ToolActivity,
  TurnTimelineItem,
} from "./session/types";

const INITIAL_UPDATE_CHECK_DELAY_MS = 1_200;
const AUTOMATIC_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;

type IconName =
  | "archive"
  | "arrow-right"
  | "arrow-down"
  | "arrow-up"
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
  | "gauge"
  | "logout"
  | "panel"
  | "paperclip"
  | "plus"
  | "refresh"
  | "search"
  | "sliders"
  | "standalone"
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
  accountProfile: AccountProfile | null;
}

interface AccountProfile {
  displayName: string | null;
  email: string | null;
}

const demoAccountProfile: AccountProfile | null = import.meta.env.DEV
  && import.meta.env.VITE_DEMO_PROFILE === "1"
  ? { displayName: "Alex Morgan", email: "alex@example.com" }
  : null;

interface CommandToken {
  query: string;
  start: number;
}

function commandTokenAtEnd(draft: string): CommandToken | null {
  const match = /(^| )\/([^\s]*)$/.exec(draft);
  if (!match) return null;
  return {
    query: match[2],
    start: (match.index ?? 0) + match[1].length,
  };
}

interface ConnectionEvent {
  status: "connected" | "disconnected";
  message?: string | null;
  sessionIds?: string[];
}

interface DeviceAuthCodeEvent {
  code: string;
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
  needsAttention: boolean;
  updatedAt: number;
  archived: boolean;
  unread: boolean;
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
  unread: boolean;
}

interface PersistedWorkspaceSummary {
  path: string;
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

function useTimingElapsed(timing: EventTiming, active: boolean) {
  const live = active && timing.startedAt !== undefined && timing.endedAt === undefined;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live, timing.startedAt]);

  if (!live && timing.startedAt !== undefined && timing.endedAt === undefined && timing.elapsedMs === undefined) {
    return { elapsedMs: undefined, live: false };
  }
  return { elapsedMs: elapsedForTiming(timing, now), live };
}

function DurationText({
  timing,
  active = false,
  className,
  label = "Elapsed time",
  prefix = "",
  formatter = formatDuration,
}: {
  timing: EventTiming;
  active?: boolean;
  className?: string;
  label?: string;
  prefix?: string;
  formatter?: (elapsedMs: number) => string;
}) {
  const { elapsedMs, live } = useTimingElapsed(timing, active);
  if (elapsedMs === undefined) return null;

  const duration = formatter(elapsedMs);
  return (
    <span
      className={["duration-text", className].filter(Boolean).join(" ")}
      role={live ? "timer" : undefined}
      aria-label={`${label}: ${duration}`}
    >
      {prefix}{duration}
    </span>
  );
}

interface AppUpdateProgress {
  stage: "downloading" | "downloaded" | "installing";
  downloaded: number;
  total: number | null;
}

type AppUpdatePhase = "idle" | "checking" | "available" | "downloading" | "error";
type AppView = "session" | "settings";
type SettingsSection = "application" | "grok" | "account" | "archived";
type ArchivedSessionSort = "updated-desc" | "updated-asc" | "title-asc" | "workspace-asc";

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

function selectModelInState(models: SessionModelState, modelId: string): SessionModelState {
  return {
    ...models,
    currentModelId: modelId,
  };
}

function selectReasoningInState(
  models: SessionModelState,
  reasoningEffort: string,
): SessionModelState {
  return {
    ...models,
    availableModels: models.availableModels.map((model) =>
      model.modelId === models.currentModelId && model.metadata
        ? {
            ...model,
            metadata: {
              ...model.metadata,
              reasoningEffort,
            },
          }
        : model
    ),
  };
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
const SIDE_PANEL_WIDTH_KEY = "groky.side-panel.width";
const SIDE_PANEL_OPEN_KEY = "groky.side-panel.open";
const DEFAULT_SIDEBAR_WIDTH = 258;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;
const FALLBACK_SIDE_PANEL_WIDTH = 480;
const DEFAULT_SIDE_PANEL_WIDTH_RATIO = 0.42;
const MIN_SIDE_PANEL_WIDTH = 340;
const MAX_SIDE_PANEL_WIDTH = 760;
const MAX_SESSION_TITLE_CHARS = 72;
const MAX_MESSAGE_ATTACHMENTS = 10;

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

function clampSidePanelWidth(width: number) {
  return Math.min(MAX_SIDE_PANEL_WIDTH, Math.max(MIN_SIDE_PANEL_WIDTH, width));
}

function defaultSidePanelWidth() {
  const viewportWidth = typeof window === "undefined" ? 0 : window.innerWidth;
  return clampSidePanelWidth(
    viewportWidth > 0 ? Math.round(viewportWidth * DEFAULT_SIDE_PANEL_WIDTH_RATIO) : FALLBACK_SIDE_PANEL_WIDTH,
  );
}

function storedSidePanelWidth() {
  try {
    const width = Number(window.localStorage.getItem(SIDE_PANEL_WIDTH_KEY));
    return Number.isFinite(width) && width > 0 ? clampSidePanelWidth(width) : defaultSidePanelWidth();
  } catch {
    return defaultSidePanelWidth();
  }
}

function storedSidePanelOpen() {
  try {
    return window.localStorage.getItem(SIDE_PANEL_OPEN_KEY) === "true";
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
    gauge: <><path d="M5.6 18a8 8 0 1 1 12.8 0" /><path d="m12 14 4-4" /><path d="M8 18h8" /></>,
    logout: <><path d="M10 5H5v14h5" /><path d="M14 8l4 4-4 4M8 12h10" /></>,
    panel: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M15 4v16" /></>,
    paperclip: <path d="m20.5 11.5-8.9 8.9a5 5 0 0 1-7.1-7.1l9.6-9.6a3.5 3.5 0 1 1 5 5l-9.6 9.6a2 2 0 0 1-2.8-2.8l8.9-8.9" />,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    refresh: <><path d="M20 6v5h-5" /><path d="M4 18v-5h5" /><path d="M18 9a7 7 0 0 0-12-2L4 11M6 15a7 7 0 0 0 12 2l2-4" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    sliders: <><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>,
    standalone: <><path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" /><circle cx="8" cy="11" r="0.8" fill="currentColor" stroke="none" /><circle cx="12" cy="11" r="0.8" fill="currentColor" stroke="none" /><circle cx="16" cy="11" r="0.8" fill="currentColor" stroke="none" /></>,
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

function sidebarSessionPriority(session: SidebarSessionSummary) {
  if (session.needsAttention) return 0;
  if (session.unread) return 1;
  if (session.running) return 2;
  return 3;
}

function compareSidebarSessions(left: SidebarSessionSummary, right: SidebarSessionSummary) {
  return sidebarSessionPriority(left) - sidebarSessionPriority(right)
    || right.updatedAt - left.updatedAt;
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
  editing,
  renaming,
  menuOpen,
  subtitle,
  onSelect,
  onToggleMenu,
  onStartRename,
  onRename,
  onCancelRename,
  onArchive,
  onRestore,
  onDelete,
}: {
  session: SidebarSessionSummary;
  selected: boolean;
  disabled: boolean;
  editing: boolean;
  renaming: boolean;
  menuOpen: boolean;
  subtitle?: string;
  onSelect: () => void;
  onToggleMenu: () => void;
  onStartRename: () => void;
  onRename: (title: string) => void;
  onCancelRename: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const renameInput = useRef<HTMLInputElement | null>(null);
  const [titleDraft, setTitleDraft] = useState(session.title);

  useEffect(() => {
    if (!editing) return;
    setTitleDraft(session.title);
    const animationFrame = window.requestAnimationFrame(() => {
      renameInput.current?.focus();
      renameInput.current?.select();
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [editing, session.title]);

  function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onRename(titleDraft);
  }

  return (
    <div
      className={`session-row ${selected ? "selected" : ""} ${editing ? "editing" : ""} ${session.unread ? "unread" : ""}`}
      data-sidebar-menu-root
      {...(editing ? { "data-session-rename-root": "" } : {})}
    >
      {editing ? (
        <form className="session-rename-form" onSubmit={submitRename}>
          <input
            ref={renameInput}
            value={titleDraft}
            aria-label={`Rename ${session.title}. Press Enter to save or Escape to cancel.`}
            disabled={renaming}
            required
            onChange={(event) => setTitleDraft(
              Array.from(event.target.value).slice(0, MAX_SESSION_TITLE_CHARS).join("")
            )}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              onCancelRename();
            }}
          />
        </form>
      ) : (
        <>
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
            {session.running && !session.needsAttention && (
              <span className="session-running-indicator" aria-label="Running">
                <span className="task-status" aria-hidden="true" />
              </span>
            )}
            {session.needsAttention && (
              <span className="session-attention-indicator" aria-label="Needs approval">!</span>
            )}
            {session.unread && !session.needsAttention && !session.running && (
              <span className="session-unread-indicator" aria-label="Unread" />
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
        </>
      )}
      {menuOpen && !editing && (
        <div className="sidebar-context-menu session-context-menu" role="menu">
          <button type="button" role="menuitem" onClick={onStartRename}>
            <Icon name="compose" size={14} />
            <span>Rename</span>
          </button>
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
        <Icon name={value ? "folder" : "standalone"} size={14} />
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
              <Icon name="standalone" size={14} />
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

function accountAvatarLabel(profile: AccountProfile | null) {
  const label = profile?.displayName ?? profile?.email ?? "G";
  return Array.from(label.trim())[0]?.toLocaleUpperCase() ?? "G";
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

function formatFileSize(bytes: number) {
  const safeBytes = Math.max(0, bytes);
  if (safeBytes < 1024) return `${safeBytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = safeBytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
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
      const attachmentNames = message.attachments?.map((attachment) => attachment.name).join(", ") ?? "";
      turns.push({
        id: message.id,
        request: previewText(message.text, 96) || attachmentNames || "Untitled request",
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

function MessageCopyButton({ text, subject }: { text: string; subject: "request" | "response" }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const resetTimer = useRef<number | null>(null);
  const buttonLabel = copyState === "copied"
    ? `${subject === "request" ? "Request" : "Response"} copied`
    : copyState === "error"
      ? `Retry copying ${subject}`
      : `Copy ${subject}`;

  useEffect(() => {
    setCopyState("idle");
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    return () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    };
  }, [text]);

  async function copyMessage() {
    try {
      await copyToClipboard(text);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }

    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 2200);
  }

  return (
    <button
      className={`message-copy-button ${copyState}`}
      type="button"
      aria-label={buttonLabel}
      title={buttonLabel}
      onClick={() => void copyMessage()}
    >
      <Icon name={copyState === "copied" ? "check" : "copy"} size={12} />
      <span className="message-copy-status" aria-live="polite">
        {copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : ""}
      </span>
    </button>
  );
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
  const dragRegionProps = overlayTitlebar ? { "data-tauri-drag-region": "deep" } : {};
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
        <span>Desktop client for Grok Build</span>
      </header>

      <main className="onboarding-main">
        <div className={`onboarding-body ${deviceAuthCode ? "auth-code-active" : ""}`}>
          <div className="onboarding-brand">
            <Brand />
          </div>

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
        </div>
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

function SidebarUpdateCard({
  update,
  phase,
  progress,
  error,
  taskRunning,
  onInstall,
}: {
  update: AppUpdateInfo;
  phase: AppUpdatePhase;
  progress: AppUpdateProgress | null;
  error: string | null;
  taskRunning: boolean;
  onInstall: () => void;
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

  const statusLabel = installing
    ? progressLabel
    : phase === "error"
      ? error ?? "The update could not be installed."
      : taskRunning
        ? "Ready after the current turn finishes."
        : "A new version is ready to install.";

  return (
    <section className={`sidebar-update-card ${phase}`} aria-live="polite" aria-label="Groky update available">
      <div className="sidebar-update-heading">
        <span className="sidebar-update-glyph"><Icon name="download" size={15} /></span>
        <span>
          <small>UPDATE AVAILABLE</small>
          <strong>Groky {update.version}</strong>
        </span>
      </div>
      <p>{statusLabel}</p>
      {installing && (
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
      )}
      <button
        type="button"
        disabled={taskRunning || installing}
        onClick={onInstall}
      >
        <Icon name="download" size={13} />
        {installing ? "Updating…" : taskRunning ? "Finish current turn first" : "Update & restart"}
      </button>
    </section>
  );
}

const SETTINGS_SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  description: string;
}> = [
  { id: "application", label: "Application", description: "Version and signed desktop updates" },
  { id: "grok", label: "Grok Build", description: "CLI and active session details" },
  { id: "account", label: "Account", description: "Authentication and sign out" },
  { id: "archived", label: "Archived chats", description: "Restore or delete archived chats" },
];

const ARCHIVED_SESSION_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function normalizeArchivedSearchValue(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function archivedSessionSearchText(session: SidebarSessionSummary) {
  return normalizeArchivedSearchValue([
    session.title,
    session.workspace ? workspaceName(session.workspace) : "Standalone",
    session.workspace ?? "No working directory",
  ].join(" "));
}

function formatArchivedUpdatedAt(timestamp: number) {
  const date = new Date(timestamp);
  const includeYear = date.getFullYear() !== new Date().getFullYear();
  return `Updated ${new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
  }).format(date)}`;
}

function SettingsSidebar({
  overlayTitlebar,
  section,
  onSectionChange,
  onBack,
}: {
  overlayTitlebar: boolean;
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onBack: () => void;
}) {
  return (
    <aside className="sidebar settings-sidebar">
      <div className="window-nav settings-window-nav" {...(overlayTitlebar ? { "data-tauri-drag-region": "deep" } : {})}>
        <button className="settings-return" type="button" onClick={onBack}>
          <Icon name="arrow-right" size={15} />
          <span>Back to Groky</span>
        </button>
      </div>

      <div className="settings-sidebar-heading">
        <h2>Settings</h2>
      </div>

      <nav className="settings-sidebar-nav" aria-label="Settings">
        {SETTINGS_SECTIONS.map((option) => (
          <button
            className={section === option.id ? "active" : ""}
            type="button"
            aria-current={section === option.id ? "page" : undefined}
            key={option.id}
            onClick={() => onSectionChange(option.id)}
          >
            <span className="settings-nav-label">{option.label}</span>
            <Icon name="arrow-right" size={12} />
          </button>
        ))}
      </nav>

      <div className="settings-sidebar-footer">
        <span className="avatar">G</span>
        <span><strong>Grok Build</strong><small>Signed in via the local CLI</small></span>
      </div>
    </aside>
  );
}

function SettingsScreen({
  overlayTitlebar,
  section,
  appVersion,
  cliVersion,
  connected,
  currentModeId,
  configOptions,
  usage,
  update,
  updatePhase,
  updateNotice,
  taskRunning,
  archivedSessions,
  archivedActionsDisabled,
  onCheckForUpdates,
  onInstallUpdate,
  onSignOut,
  onRestoreArchived,
  onDeleteArchived,
}: {
  overlayTitlebar: boolean;
  section: SettingsSection;
  appVersion: string | null;
  cliVersion: string | null;
  connected: boolean;
  currentModeId: string | null;
  configOptions: SessionConfigOption[];
  usage: SessionUsage | null;
  update: AppUpdateInfo | null;
  updatePhase: AppUpdatePhase;
  updateNotice: string | null;
  taskRunning: boolean;
  archivedSessions: SidebarSessionSummary[];
  archivedActionsDisabled: boolean;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
  onSignOut: () => void;
  onRestoreArchived: (sessionId: string) => void;
  onDeleteArchived: (session: SidebarSessionSummary) => void;
}) {
  const [archivedQuery, setArchivedQuery] = useState("");
  const [archivedSort, setArchivedSort] = useState<ArchivedSessionSort>("updated-desc");
  const checkingForUpdates = updatePhase === "checking";
  const updating = updatePhase === "downloading";
  const activeSection = SETTINGS_SECTIONS.find((option) => option.id === section) ?? SETTINGS_SECTIONS[0];
  const visibleArchivedSessions = useMemo(() => {
    const tokens = normalizeArchivedSearchValue(archivedQuery).trim().split(/\s+/).filter(Boolean);
    const matchingSessions = archivedSessions.filter((session) => {
      if (tokens.length === 0) return true;
      const searchable = archivedSessionSearchText(session);
      return tokens.every((token) => searchable.includes(token));
    });

    return [...matchingSessions].sort((left, right) => {
      const titleOrder = ARCHIVED_SESSION_COLLATOR.compare(left.title, right.title);
      const leftWorkspace = left.workspace ? workspaceName(left.workspace) : "Standalone";
      const rightWorkspace = right.workspace ? workspaceName(right.workspace) : "Standalone";

      switch (archivedSort) {
        case "updated-asc":
          return left.updatedAt - right.updatedAt || titleOrder;
        case "title-asc":
          return titleOrder || right.updatedAt - left.updatedAt;
        case "workspace-asc":
          return ARCHIVED_SESSION_COLLATOR.compare(leftWorkspace, rightWorkspace)
            || titleOrder
            || right.updatedAt - left.updatedAt;
        case "updated-desc":
        default:
          return right.updatedAt - left.updatedAt || titleOrder;
      }
    });
  }, [archivedQuery, archivedSessions, archivedSort]);
  const updateButtonLabel = update
    ? updating
      ? "Updating…"
      : taskRunning
        ? "Finish current turn first"
        : "Update & restart"
    : checkingForUpdates
      ? "Checking…"
      : "Check now";

  return (
    <div className="settings-page">
      <header className="taskbar settings-taskbar" {...(overlayTitlebar ? { "data-tauri-drag-region": "deep" } : {})}>
        <div className="taskbar-leading">
          <div className="task-title"><Icon name="sliders" /><strong>{activeSection.label}</strong></div>
        </div>
      </header>

      <div className="settings-scroll">
        <div className="settings-content">
          <div className="settings-intro">
            <span>GROKY / SETTINGS</span>
            <h1>{activeSection.label}</h1>
            <p>{activeSection.description}.</p>
          </div>

          {section === "application" && <section className="settings-card" aria-labelledby="application-settings-title">
            <header>
              <div>
                <h2 id="application-settings-title">Application</h2>
                <p>Version and signed desktop updates.</p>
              </div>
            </header>
            <div className="settings-list">
              <div className="settings-row">
                <div><strong>Groky version</strong><small>The version installed on this device.</small></div>
                <span className="settings-value">{appVersion ? `Version ${appVersion}` : "Unavailable"}</span>
              </div>
              <div className="settings-row settings-update-row">
                <div>
                  <strong>Software updates</strong>
                  <small>{update
                    ? `Version ${update.version} is available. Groky found it automatically.`
                    : "Groky checks automatically and will notify you when a new version is ready."}</small>
                </div>
                <button
                  type="button"
                  disabled={checkingForUpdates || updating || (update !== null && taskRunning)}
                  onClick={update ? onInstallUpdate : onCheckForUpdates}
                >
                  <Icon name={update ? "download" : "refresh"} size={14} />
                  {updateButtonLabel}
                </button>
              </div>
              {updateNotice && <p className="settings-inline-notice" role="status">{updateNotice}</p>}
            </div>
          </section>}

          {section === "grok" && <section className="settings-card" aria-labelledby="grok-settings-title">
            <header>
              <div>
                <h2 id="grok-settings-title">Grok Build</h2>
                <p>Details reported by the local CLI and active session.</p>
              </div>
            </header>
            <div className="settings-list">
              <div className="settings-row">
                <div><strong>Connection</strong><small>Local ACP transport status.</small></div>
                <span className={`settings-status ${connected ? "connected" : ""}`}><i />{connected ? "Connected" : "Ready"}</span>
              </div>
              <div className="settings-row">
                <div><strong>Engine</strong><small>Grok Build CLI detected by Groky.</small></div>
                <span className="settings-value">{cliVersion ?? "Not detected"}</span>
              </div>
              {currentModeId && (
                <div className="settings-row">
                  <div><strong>Session mode</strong><small>Current mode reported through ACP.</small></div>
                  <span className="settings-value">{currentModeId}</span>
                </div>
              )}
              {usage && (
                <div className="settings-row">
                  <div><strong>Context usage</strong><small>Cumulative context reported by the active session.</small></div>
                  <span className="settings-value">
                    {formatTokenCount(usage.used)} / {formatTokenCount(usage.size)}
                    {usage.size > 0 ? ` (${Math.round((usage.used / usage.size) * 100)}%)` : ""}
                  </span>
                </div>
              )}
              {usage?.cost && (
                <div className="settings-row">
                  <div><strong>Session cost</strong><small>Cumulative estimate reported by Grok Build.</small></div>
                  <span className="settings-value">{usage.cost.amount.toFixed(4)} {usage.cost.currency}</span>
                </div>
              )}
              {configOptions.map((option) => (
                <div className="settings-row" key={option.id}>
                  <div><strong>{option.name}</strong><small>{option.description ?? "Session option reported through ACP."}</small></div>
                  <span className="settings-value">
                    {option.value === undefined || option.value === null ? "Available" : option.value ? "On" : "Off"}
                  </span>
                </div>
              ))}
            </div>
          </section>}

          {section === "account" && <section className="settings-card settings-account-card" aria-labelledby="account-settings-title">
            <header>
              <div>
                <h2 id="account-settings-title">Account</h2>
                <p>Authentication is managed by the official Grok Build CLI.</p>
              </div>
            </header>
            <div className="settings-account-action">
              <div><strong>Signed in</strong><small>Signing out clears the current Groky session.</small></div>
              <button type="button" onClick={onSignOut}><Icon name="logout" size={14} /> Sign out</button>
            </div>
          </section>}

          {section === "archived" && <section className="settings-card archived-settings-card" aria-labelledby="archived-settings-title">
            <header>
              <div>
                <h2 id="archived-settings-title">Archived chats</h2>
                <p>Chats kept outside the main sidebar.</p>
              </div>
            </header>
            {archivedSessions.length > 0 ? (
              <div className="archived-settings-browser">
                <div className="archived-settings-controls">
                  <div className="archived-settings-search">
                    <Icon name="search" size={14} />
                    <input
                      type="search"
                      value={archivedQuery}
                      aria-label="Search archived chats"
                      placeholder="Search archived chats"
                      onChange={(event) => setArchivedQuery(event.target.value)}
                    />
                    {archivedQuery && (
                      <button type="button" aria-label="Clear archived chat search" onClick={() => setArchivedQuery("")}>
                        <Icon name="x" size={12} />
                      </button>
                    )}
                  </div>
                  <label className="archived-settings-sort">
                    <Icon name="sliders" size={13} />
                    <select
                      aria-label="Sort archived chats"
                      value={archivedSort}
                      onChange={(event) => setArchivedSort(event.target.value as ArchivedSessionSort)}
                    >
                      <option value="updated-desc">Recently updated</option>
                      <option value="updated-asc">Least recently updated</option>
                      <option value="title-asc">Title A–Z</option>
                      <option value="workspace-asc">Workspace A–Z</option>
                    </select>
                    <Icon name="chevron-down" size={11} />
                  </label>
                  <span className="archived-settings-count" role="status" aria-live="polite">
                    {archivedQuery.trim()
                      ? `${visibleArchivedSessions.length} of ${archivedSessions.length} chats`
                      : `${archivedSessions.length} ${archivedSessions.length === 1 ? "chat" : "chats"}`}
                  </span>
                </div>

                {visibleArchivedSessions.length > 0 ? (
                  <div className="archived-settings-list">
                    {visibleArchivedSessions.map((session) => (
                      <div className="archived-settings-row" key={session.sessionId}>
                        <span className="archived-settings-icon"><Icon name="archive" size={14} /></span>
                        <span className="archived-settings-copy">
                          <strong>{session.title}</strong>
                          <small>
                            <span title={session.workspace ?? "No working directory"}>
                              {session.workspace ? workspaceName(session.workspace) : "Standalone"}
                            </span>
                            <span aria-hidden="true">·</span>
                            <time dateTime={new Date(session.updatedAt).toISOString()}>{formatArchivedUpdatedAt(session.updatedAt)}</time>
                          </small>
                        </span>
                        <span className="archived-settings-actions">
                          <button
                            type="button"
                            disabled={archivedActionsDisabled}
                            onClick={() => onRestoreArchived(session.sessionId)}
                          >
                            <Icon name="refresh" size={13} />
                            Restore
                          </button>
                          <button
                            className="archived-delete"
                            type="button"
                            aria-label={`Delete ${session.title}`}
                            disabled={archivedActionsDisabled}
                            onClick={() => onDeleteArchived(session)}
                          >
                            <Icon name="trash" size={13} />
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="archived-settings-empty archived-settings-no-results">
                    <Icon name="search" size={17} />
                    <strong>No matching chats</strong>
                    <p>Try a title, workspace name, or working directory.</p>
                    <button type="button" onClick={() => setArchivedQuery("")}>Clear search</button>
                  </div>
                )}
              </div>
            ) : (
              <div className="archived-settings-empty">
                <Icon name="archive" size={17} />
                <strong>No archived chats</strong>
                <p>Archived chats will appear here instead of in the main sidebar.</p>
              </div>
            )}
          </section>}
        </div>
      </div>
    </div>
  );
}

function ApprovalModeSelector({
  mode,
  busy,
  changing,
  onChange,
}: {
  mode: ApprovalMode;
  busy: boolean;
  changing: boolean;
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
    if (busy || changing) setOpen(false);
  }, [busy, changing]);

  return (
    <div className={`approval-control mode-${mode} ${changing ? "is-changing" : ""}`} ref={root}>
      <button
        className="approval-button"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Approval mode: ${selected.label}${changing ? ", updating" : ""}`}
        aria-busy={changing}
        disabled={busy || changing}
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
                  disabled={busy || changing}
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
          <div className="approval-menu-note">
            <span>{selected.shortDescription}</span>
            <small>Changes apply before the next request in this session.</small>
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
  const [menuPosition, setMenuPosition] = useState<{ right: number; bottom: number } | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const selected = currentModel(models);
  const reasoningEffort = selected?.metadata?.reasoningEffort;
  const reasoningEfforts = selected?.metadata?.supportsReasoningEffort === false
    ? []
    : selected?.metadata?.reasoningEfforts ?? [];
  const selectedReasoning = reasoningEfforts.find((effort) =>
    effort.id === reasoningEffort || effort.value === reasoningEffort
  );
  const reasoningLabel = selectedReasoning?.label.replace(/\s+Effort$/i, "") ?? reasoningEffort;
  const changing = changingModelId !== null || changingReasoningEffort !== null;

  const updateMenuPosition = useCallback(() => {
    const bounds = root.current?.getBoundingClientRect();
    if (!bounds) return;

    setMenuPosition({
      right: Math.max(8, window.innerWidth - bounds.right - 3),
      bottom: Math.max(8, window.innerHeight - bounds.top + 8),
    });
  }, []);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
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

  useLayoutEffect(() => {
    if (!open) return;

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (busy) setOpen(false);
  }, [busy]);

  async function toggleMenu() {
    if (open) {
      setOpen(false);
      return;
    }
    if (!connected && !models) {
      setLoading(true);
      const loaded = await onLoad();
      setLoading(false);
      if (!loaded) return;
    }
    setActiveSection(null);
    updateMenuPosition();
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
        <span>{loading ? "Loading models…" : selected?.name ?? "Grok Build"}</span>
        <span className="reasoning">· {reasoningLabel ?? (connected ? "ACP" : "default")}</span>
        <Icon name="chevron-down" size={12} />
      </button>

      {open && menuPosition && createPortal(
        <div
          ref={menu}
          className="approval-menu model-menu model-menu-portal"
          role="menu"
          aria-label="Grok Build model and reasoning settings"
          style={{ right: menuPosition.right, bottom: menuPosition.bottom }}
        >
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
        </div>,
        root.current?.closest<HTMLElement>(".app-shell") ?? document.body,
      )}
    </div>
  );
}

function App() {
  const overlayTitlebar = usesOverlayTitlebar();
  const dragRegionProps = overlayTitlebar ? { "data-tauri-drag-region": "deep" } : {};
  const sidebarShortcutLabel = isMacOS() ? "⌘B" : "Ctrl+B";
  const sidePanelShortcutLabel = isMacOS() ? "⌘J" : "Ctrl+J";
  const searchShortcutLabel = isMacOS() ? "⌘K" : "Ctrl+K";
  const [stage, setStage] = useState<OnboardingStage>("checking");
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [sessionViews, setSessionViews] = useState<Record<string, SessionViewState>>({});
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loadingSessionIds, setLoadingSessionIds] = useState<Set<string>>(() => new Set());
  const [approvalModeChangingIds, setApprovalModeChangingIds] = useState<Set<string>>(() => new Set());
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [deviceAuthCode, setDeviceAuthCode] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [sessionHistory, setSessionHistory] = useState<PersistedSessionSummary[]>([]);
  const [workspaceHistory, setWorkspaceHistory] = useState<PersistedWorkspaceSummary[]>([]);
  const [pendingModels, setPendingModels] = useState<SessionModelState | null>(null);
  const [commandCatalogs, setCommandCatalogs] = useState<Record<string, AvailableCommand[]>>({});
  const [pendingDraft, setPendingDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<FileAttachment[]>([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [fileDragActive, setFileDragActive] = useState(false);
  const [fileDragCount, setFileDragCount] = useState(0);
  const [respondingPermissionId, setRespondingPermissionId] = useState<string | null>(null);
  const [showConnection, setShowConnection] = useState(false);
  const [activeView, setActiveView] = useState<AppView>("session");
  const [activeSettingsSection, setActiveSettingsSection] = useState<SettingsSection>("application");
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
  const [sidePanelWidth, setSidePanelWidth] = useState(storedSidePanelWidth);
  const [sidePanelOpen, setSidePanelOpen] = useState(storedSidePanelOpen);
  const [sidePanelMounted, setSidePanelMounted] = useState(storedSidePanelOpen);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(() => new Set());
  const [sidebarMenu, setSidebarMenu] = useState<SidebarMenu>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteConfirmation | null>(null);
  const [historyMutating, setHistoryMutating] = useState(false);
  const [nativeTitlebarHeight, setNativeTitlebarHeight] = useState<number | null>(null);
  const [commandSuggestionsOpen, setCommandSuggestionsOpen] = useState(true);
  const [activeCommandSuggestion, setActiveCommandSuggestion] = useState(0);
  const toggleSidePanel = useCallback(() => {
    setSidePanelMounted(true);
    setSidePanelOpen((current) => !current);
  }, []);
  const commandSuggestionsId = useId();
  const activeSessionIdRef = useRef<string | null>(null);
  const activeAssistantIds = useRef<Map<string, string>>(new Map());
  const sessionViewsRef = useRef(sessionViews);
  const autoScrollEnabled = useRef(true);
  const conversation = useRef<HTMLElement | null>(null);
  const conversationContent = useRef<HTMLDivElement | null>(null);
  const composerDock = useRef<HTMLDivElement | null>(null);
  const composerTextarea = useRef<HTMLTextAreaElement | null>(null);
  const commandSuggestionsList = useRef<HTMLDivElement | null>(null);
  const commandCatalogRequests = useRef<Set<string>>(new Set());
  const updateCheckInFlight = useRef(false);
  const updateInstallationInFlight = useRef(false);
  const connectionTransitioning = useRef(false);
  const sidebarResizeStart = useRef<{ pointerX: number; width: number } | null>(null);
  const sidePanelResizeStart = useRef<{ pointerX: number; width: number } | null>(null);

  const activeSession = activeSessionId ? sessionViews[activeSessionId] : undefined;
  const connection = activeSession && !activeSession.disconnected ? activeSession.connection : null;
  const messages = activeSession?.messages ?? [];
  const draft = activeSession?.draft ?? pendingDraft;
  const attachments = activeSession?.attachments ?? pendingAttachments;
  const running = activeSession?.running ?? false;
  const activeRunStartedAt = running
    ? [...messages].reverse().find((message) => message.role === "assistant" && message.state === "streaming")?.startedAt
    : undefined;
  const permission = activeSession?.permissions[0] ?? null;
  const plan = activeSession?.plan ?? [];
  const activeSessionLoading = activeSessionId !== null && loadingSessionIds.has(activeSessionId);
  const activeApprovalModeChanging = activeSessionId !== null
    && approvalModeChangingIds.has(activeSessionId);
  const anySessionRunning = Object.values(sessionViews).some((session) => session.running);
  const sessionTransitioning = activeSessionLoading || stage === "connecting";
  const commandCatalogKey = workspace ?? "__standalone__";
  const availableCommandsForComposer = activeSession?.availableCommands
    ?? commandCatalogs[commandCatalogKey]
    ?? Object.values(sessionViews).find((session) => session.connection.workspace === workspace)?.availableCommands
    ?? [];
  const commandSuggestions = useMemo(() => {
    if (!commandSuggestionsOpen) return [];
    const token = commandTokenAtEnd(draft);
    if (!token) return [];
    const query = token.query.toLocaleLowerCase();
    return availableCommandsForComposer
      .filter((command) => command.name.toLocaleLowerCase().includes(query))
      .sort((left, right) => {
        if (!query) return 0;
        const leftStartsWith = left.name.toLocaleLowerCase().startsWith(query);
        const rightStartsWith = right.name.toLocaleLowerCase().startsWith(query);
        return Number(rightStartsWith) - Number(leftStartsWith);
      })
      .slice(0, 8);
  }, [availableCommandsForComposer, commandSuggestionsOpen, draft]);

  useEffect(() => {
    setActiveCommandSuggestion(0);
  }, [activeSessionId, draft]);

  useEffect(() => {
    setCommandSuggestionsOpen(true);
  }, [activeSessionId]);

  useEffect(() => {
    if (commandSuggestions.length === 0) return;
    const selected = commandSuggestionsList.current?.querySelector<HTMLElement>(
      `[data-command-index="${activeCommandSuggestion}"]`,
    );
    selected?.scrollIntoView({ block: "nearest" });
  }, [activeCommandSuggestion, commandSuggestions.length]);

  function updateSessionView(
    sessionId: string,
    update: (current: SessionViewState) => SessionViewState,
    render = true,
  ) {
    const current = sessionViewsRef.current;
    const session = current[sessionId];
    if (!session) return;
    const next = { ...current, [sessionId]: update(session) };
    sessionViewsRef.current = next;
    if (render) setSessionViews(next);
  }

  function setSessionMessages(
    sessionId: string,
    action: SetStateAction<ConversationMessage[]>,
  ) {
    updateSessionView(
      sessionId,
      (session) => ({
        ...session,
        messages: typeof action === "function" ? action(session.messages) : action,
      }),
      activeSessionIdRef.current === sessionId,
    );
  }

  function setSessionRunning(sessionId: string, running: boolean) {
    updateSessionView(sessionId, (session) => ({ ...session, running }));
  }

  function enqueueSessionPermission(sessionId: string, permission: PermissionRequest) {
    updateSessionView(sessionId, (session) => ({
      ...session,
      permissions: [
        ...session.permissions.filter((entry) => entry.requestId !== permission.requestId),
        permission,
      ],
    }));
  }

  function resolveSessionPermission(sessionId: string, requestId: string) {
    updateSessionView(sessionId, (session) => ({
      ...session,
      permissions: session.permissions.filter((entry) => entry.requestId !== requestId),
    }));
  }

  function setDraft(next: string) {
    setCommandSuggestionsOpen(true);
    const sessionId = activeSessionIdRef.current;
    if (sessionId) {
      updateSessionView(sessionId, (session) => ({ ...session, draft: next }));
    } else {
      setPendingDraft(next);
    }
  }

  function setAttachments(next: FileAttachment[]) {
    const sessionId = activeSessionIdRef.current;
    if (sessionId) {
      updateSessionView(sessionId, (session) => ({ ...session, attachments: next }));
    } else {
      setPendingAttachments(next);
    }
  }

  function activateSession(sessionId: string | null) {
    activeSessionIdRef.current = sessionId;
    if (sessionId) {
      setSessionHistory((current) => current.map((session) =>
        session.sessionId === sessionId && session.unread
          ? { ...session, unread: false }
          : session
      ));
    }
    setSessionViews(sessionViewsRef.current);
    setActiveSessionId(sessionId);
    if (isTauri()) {
      void invoke("grok_activate_session", { sessionId }).catch(() => undefined);
    }
  }

  function upsertSessionView(
    nextConnection: Connection,
    nextMessages?: ConversationMessage[],
    replay?: SessionReplayProjection,
  ) {
    if (nextConnection.models) setPendingModels(nextConnection.models);
    const current = sessionViewsRef.current;
    const existing = current[nextConnection.sessionId];
    const next = {
      ...current,
      [nextConnection.sessionId]: {
        connection: nextConnection,
        disconnected: false,
        messages: nextMessages ?? existing?.messages ?? [],
        draft: existing?.draft ?? "",
        attachments: existing?.attachments ?? [],
        running: existing?.running ?? false,
        permissions: replay ? replay.permissions : existing?.permissions ?? [],
        availableCommands: replay?.availableCommands
          ?? existing?.availableCommands
          ?? nextConnection.availableCommands,
        currentModeId: replay?.currentModeId ?? existing?.currentModeId ?? null,
        configOptions: replay?.configOptions ?? existing?.configOptions ?? [],
        usage: replay?.usage ?? existing?.usage ?? null,
        plan: replay?.plan ?? existing?.plan ?? [],
      },
    };
    sessionViewsRef.current = next;
    setSessionViews(next);
  }

  function clearAllSessionViews() {
    activeSessionIdRef.current = null;
    activeAssistantIds.current.clear();
    sessionViewsRef.current = {};
    setActiveSessionId(null);
    setSessionViews({});
    setLoadingSessionIds(new Set());
    setApprovalModeChangingIds(new Set());
    setPendingModels(null);
    setCommandCatalogs({});
    commandCatalogRequests.current.clear();
    setPendingAttachments([]);
  }

  const sessionWorkspace = connection?.workspace ?? workspace;
  const projectName = useMemo(() => workspaceName(sessionWorkspace), [sessionWorkspace]);
  const activeSessionTitle = activeSessionId
    ? sessionHistory.find((session) => session.sessionId === activeSessionId)?.title ?? "New Grok session"
    : "New session";
  const accountProfile = demoAccountProfile ?? status?.accountProfile ?? null;
  const accountName = accountProfile?.displayName ?? accountProfile?.email ?? "Grok Build";
  const accountDetail = accountProfile?.displayName && accountProfile.email
    ? accountProfile.email
    : cleanVersion(connection?.cliVersion ?? status?.cliVersion ?? null);
  const messageHistory = useMemo(() => conversationTurnPreviews(messages), [messages]);
  const appUpdating = updatePhase === "downloading";
  const sidebarSessions: SidebarSessionSummary[] = sessionHistory.map((session) => ({
    ...session,
    running: sessionViews[session.sessionId]?.running ?? false,
    needsAttention: (sessionViews[session.sessionId]?.permissions.length ?? 0) > 0,
  })).sort(compareSidebarSessions);
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
  const sidebarActionsDisabled = appUpdating || stage === "connecting" || historyMutating || renamingSessionId !== null;
  const sessionLocationEditable = !activeSessionLoading && connection === null && messages.length === 0 && !running;
  const attachmentDisabled = activeSessionLoading || running || appUpdating || stage === "connecting";

  const addAttachmentPaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0 || attachmentDisabled) return;
    const targetSessionId = activeSessionIdRef.current;
    setAttachmentBusy(true);
    try {
      const inspected = await invoke<FileAttachment[]>("inspect_attachments", {
        paths: [...attachments.map((attachment) => attachment.path), ...paths],
      });
      if (targetSessionId) {
        updateSessionView(targetSessionId, (session) => ({ ...session, attachments: inspected }));
      } else {
        setPendingAttachments(inspected);
      }
    } catch (error) {
      setConnectionNotice(String(error));
    } finally {
      setAttachmentBusy(false);
    }
  }, [attachmentDisabled, attachments]);

  function addWorkspaceAttachment(attachment: FileAttachment) {
    if (attachmentDisabled || attachments.length >= MAX_MESSAGE_ATTACHMENTS) {
      if (attachments.length >= MAX_MESSAGE_ATTACHMENTS) {
        setConnectionNotice(`Attach up to ${MAX_MESSAGE_ATTACHMENTS} files at a time.`);
      }
      return false;
    }
    if (attachments.some((current) => current.path === attachment.path)) return false;
    setAttachments([...attachments, attachment]);
    return true;
  }

  async function chooseAttachmentFiles() {
    if (attachmentDisabled || attachmentBusy) return;
    setAttachmentBusy(true);
    try {
      const selected = await invoke<FileAttachment[]>("choose_attachments");
      if (selected.length > 0) {
        await addAttachmentPaths(selected.map((attachment) => attachment.path));
      }
    } catch (error) {
      setConnectionNotice(String(error));
    } finally {
      setAttachmentBusy(false);
    }
  }

  useEffect(() => {
    if (!isTauri()) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "leave") {
        setFileDragActive(false);
        setFileDragCount(0);
        return;
      }
      if (activeView !== "session" || attachmentDisabled) {
        setFileDragActive(false);
        return;
      }
      if (payload.type === "enter") {
        setFileDragActive(true);
        setFileDragCount(payload.paths.length);
      } else if (payload.type === "over") {
        setFileDragActive(true);
      } else if (payload.type === "drop") {
        setFileDragActive(false);
        setFileDragCount(0);
        void addAttachmentPaths(payload.paths);
      }
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    }).catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [activeView, attachmentDisabled, addAttachmentPaths]);

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
    try {
      window.localStorage.setItem(SIDE_PANEL_WIDTH_KEY, String(sidePanelWidth));
    } catch {
      // Persistence is optional when storage is unavailable.
    }
  }, [sidePanelWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDE_PANEL_OPEN_KEY, String(sidePanelOpen));
    } catch {
      // Persistence is optional when storage is unavailable.
    }
  }, [sidePanelOpen]);

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
    const handleSearchShortcut = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      if (globalSearchOpen) {
        setGlobalSearchOpen(false);
        return;
      }
      if ((stage !== "ready" && stage !== "connected") || deleteConfirmation) return;
      setShowConnection(false);
      setSidebarMenu(null);
      setEditingSessionId(null);
      setGlobalSearchOpen(true);
    };

    window.addEventListener("keydown", handleSearchShortcut);
    return () => window.removeEventListener("keydown", handleSearchShortcut);
  }, [deleteConfirmation, globalSearchOpen, stage]);

  useEffect(() => {
    const handleSidePanelShortcut = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "j") return;
      event.preventDefault();
      toggleSidePanel();
    };

    window.addEventListener("keydown", handleSidePanelShortcut);
    return () => {
      window.removeEventListener("keydown", handleSidePanelShortcut);
      document.body.classList.remove("is-resizing-side-panel");
    };
  }, [toggleSidePanel]);

  useEffect(() => {
    if ((stage !== "ready" && stage !== "connected") || deleteConfirmation) {
      setGlobalSearchOpen(false);
    }
  }, [deleteConfirmation, stage]);

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
    if (!editingSessionId) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (
        renamingSessionId === null
        && (!(event.target instanceof Element) || !event.target.closest("[data-session-rename-root]"))
      ) {
        setEditingSessionId(null);
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && renamingSessionId === null) setEditingSessionId(null);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [editingSessionId, renamingSessionId]);

  useEffect(() => {
    if (!showConnection) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[data-connection-popover-root]")) {
        setShowConnection(false);
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setShowConnection(false);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [showConnection]);

  useEffect(() => {
    if (activeView !== "settings") return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !showConnection && !sidebarMenu && !deleteConfirmation) {
        setActiveView("session");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeView, deleteConfirmation, showConnection, sidebarMenu]);

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

  function openGlobalSearch() {
    if ((stage !== "ready" && stage !== "connected") || deleteConfirmation) return;
    setShowConnection(false);
    setSidebarMenu(null);
    setEditingSessionId(null);
    setGlobalSearchOpen(true);
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

  function startSidePanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !sidePanelOpen) return;
    event.preventDefault();
    event.currentTarget.focus();
    sidePanelResizeStart.current = { pointerX: event.clientX, width: sidePanelWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing-side-panel");
  }

  function resizeSidePanel(event: ReactPointerEvent<HTMLDivElement>) {
    const start = sidePanelResizeStart.current;
    if (!start) return;
    setSidePanelWidth(clampSidePanelWidth(start.width - event.clientX + start.pointerX));
  }

  function finishSidePanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!sidePanelResizeStart.current) return;
    sidePanelResizeStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("is-resizing-side-panel");
  }

  function resizeSidePanelWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 32 : 12;
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = sidePanelWidth + step;
    if (event.key === "ArrowRight") nextWidth = sidePanelWidth - step;
    if (event.key === "Home") nextWidth = MIN_SIDE_PANEL_WIDTH;
    if (event.key === "End") nextWidth = MAX_SIDE_PANEL_WIDTH;
    if (nextWidth === null) return;
    event.preventDefault();
    setSidePanelWidth(clampSidePanelWidth(nextWidth));
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

    const runAutomaticUpdateCheck = () => {
      if (disposed || updateCheckInFlight.current || updateInstallationInFlight.current) return;
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
    };

    const initialUpdateTimer = window.setTimeout(runAutomaticUpdateCheck, INITIAL_UPDATE_CHECK_DELAY_MS);
    const automaticUpdateTimer = window.setInterval(
      runAutomaticUpdateCheck,
      AUTOMATIC_UPDATE_CHECK_INTERVAL_MS,
    );

    void listen<AppUpdateProgress>("groky://update-progress", ({ payload }) => {
      setUpdateProgress(payload);
      setUpdatePhase("downloading");
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });

    return () => {
      disposed = true;
      window.clearTimeout(initialUpdateTimer);
      window.clearInterval(automaticUpdateTimer);
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    void Promise.all([
      listen<SessionUpdate>("grok://session-update", ({ payload }) => {
        if (payload.kind === "available_commands_update") {
          updateSessionView(payload.sessionId, (session) => ({
            ...session,
            availableCommands: payload.availableCommands,
          }));
        } else if (payload.kind === "current_mode_update") {
          updateSessionView(payload.sessionId, (session) => ({
            ...session,
            currentModeId: payload.currentModeId,
          }));
        } else if (payload.kind === "config_option_update") {
          updateSessionView(payload.sessionId, (session) => ({
            ...session,
            configOptions: payload.configOptions,
          }));
        } else if (payload.kind === "usage_update") {
          updateSessionView(payload.sessionId, (session) => ({
            ...session,
            usage: { used: payload.used, size: payload.size, cost: payload.cost },
          }));
        } else if (payload.kind === "plan") {
          updateSessionView(payload.sessionId, (session) => ({
            ...session,
            plan: payload.entries,
          }));
        } else if (payload.kind === "session_info_update") {
          const parsedUpdatedAt = payload.updatedAt ? Date.parse(payload.updatedAt) : Number.NaN;
          setSessionHistory((current) => current.map((entry) => entry.sessionId === payload.sessionId
            ? {
                ...entry,
                title: payload.title || entry.title,
                updatedAt: Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : entry.updatedAt,
              }
            : entry));
        } else if (payload.kind === "permission_decision") {
          resolveSessionPermission(payload.sessionId, payload.requestId);
        }

        const messageId = activeAssistantIds.current.get(payload.sessionId);
        if (!messageId) return;
        setSessionMessages(payload.sessionId, (current) => current.map((message) => {
          if (message.id !== messageId) return message;
          return applySessionUpdateToMessage(message, payload, Date.now());
        }));
      }),
      listen<PermissionRequest>("grok://permission-request", ({ payload }) => {
        const messageId = activeAssistantIds.current.get(payload.sessionId);
        if (messageId) {
          const requestedAt = Date.now();
          const update: SessionUpdate = {
            kind: "permission_requested",
            sessionId: payload.sessionId,
            requestId: payload.requestId,
            toolCallId: payload.toolCallId,
            title: payload.title,
            toolKind: payload.toolKind,
            options: payload.options,
          };
          setSessionMessages(payload.sessionId, (current) => current.map((message) =>
            message.id === messageId ? applySessionUpdateToMessage(message, update, requestedAt) : message
          ));
        }
        enqueueSessionPermission(payload.sessionId, payload);
        if (payload.sessionId !== activeSessionIdRef.current) {
          setConnectionNotice("A background session is waiting for approval.");
        }
      }),
      listen<ConnectionEvent>("grok://connection", ({ payload }) => {
        if (payload.status !== "disconnected") return;
        const affectedSessionIds = payload.sessionIds ?? [];
        const endedAt = Date.now();
        affectedSessionIds.forEach((sessionId) => {
          const messageId = activeAssistantIds.current.get(sessionId);
          updateSessionView(sessionId, (session) => ({
            ...session,
            disconnected: true,
            running: false,
            permissions: [],
            messages: session.messages.map((message) => message.id === messageId
              ? {
                  ...finishRun(message, endedAt, "failed"),
                  state: "error",
                  error: payload.message ?? "Grok Build disconnected.",
                }
              : message),
          }));
          activeAssistantIds.current.delete(sessionId);
        });
        if (
          activeSessionIdRef.current
          && (affectedSessionIds.length === 0 || affectedSessionIds.includes(activeSessionIdRef.current))
          && !connectionTransitioning.current
        ) {
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
  }, []);

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
  }, [draft, sidePanelOpen, sidePanelWidth, sidebarCollapsed, sidebarWidth, stage]);

  useLayoutEffect(() => {
    const container = conversation.current;
    const content = conversationContent.current;
    const composerDockElement = composerDock.current;
    if (!container || !content || !composerDockElement) return;

    const syncScrollPosition = () => {
      if (autoScrollEnabled.current) {
        container.scrollTop = container.scrollHeight;
        setShowScrollToLatest(false);
      } else {
        const hasContentBelow = container.scrollHeight - container.scrollTop - container.clientHeight > 2;
        autoScrollEnabled.current = !hasContentBelow;
        setShowScrollToLatest(hasContentBelow);
      }

      updateActiveHistoryMessage(container);
    };
    syncScrollPosition();

    const observer = new ResizeObserver(syncScrollPosition);
    observer.observe(container);
    observer.observe(content);
    observer.observe(composerDockElement);
    return () => {
      observer.disconnect();
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

  async function openUsageDetails() {
    setShowConnection(false);
    try {
      await invoke("open_grok_usage");
    } catch (error) {
      setConnectionNotice(String(error));
    }
  }

  async function checkForAppUpdate(manual: boolean) {
    if (updatePhase === "downloading" || updateCheckInFlight.current || updateInstallationInFlight.current) return;
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
    if (
      !appUpdate
      || anySessionRunning
      || updatePhase === "downloading"
      || updateCheckInFlight.current
      || updateInstallationInFlight.current
    ) return;
    updateInstallationInFlight.current = true;
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
      updateInstallationInFlight.current = false;
    }
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

  async function createSessionForSubmission() {
    setSetupError(null);
    setConnectionNotice(null);
    connectionTransitioning.current = true;
    setStage("connecting");
    try {
      const requestedModel = currentModel(pendingModels);
      const next = await invoke<Connection>("grok_connect", {
        workspace,
        approvalMode,
        modelId: pendingModels?.currentModelId,
        reasoningEffort: requestedModel?.metadata?.reasoningEffort,
      });
      upsertSessionView(next);
      activateSession(next.sessionId);
      setWorkspace(next.workspace);
      setApprovalMode(next.approvalMode);
      setStatus((current) => current ? { ...current, stage: "connected", cliVersion: next.cliVersion } : current);
      setStage("connected");
      await refreshSessionHistory();
      connectionTransitioning.current = false;
      return next;
    } catch (error) {
      const message = String(error);
      const authRequired = message.includes(AUTH_REQUIRED_ERROR);
      setSetupError(authRequired ? null : message);
      setStage(authRequired ? "needsAuth" : activeSessionIdRef.current ? "connected" : "ready");
      connectionTransitioning.current = false;
      return null;
    }
  }

  async function loadSession(session: PersistedSessionSummary) {
    setSidebarMenu(null);
    setActiveView("session");
    if (
      (session.sessionId === activeSessionIdRef.current
        && !sessionViewsRef.current[session.sessionId]?.disconnected)
      || appUpdating
    ) return;

    const previousSessionId = activeSessionIdRef.current;
    const cached = sessionViewsRef.current[session.sessionId];
    activateSession(session.sessionId);
    setShowConnection(false);
    setSetupError(null);
    setConnectionNotice(null);
    setWorkspace(cached?.connection.workspace ?? session.workspace);
    if (cached) setApprovalMode(cached.connection.approvalMode);
    else {
      setPendingDraft("");
      setPendingAttachments([]);
    }
    if (loadingSessionIds.has(session.sessionId)) return;
    if (!cached) {
      setLoadingSessionIds((current) => new Set(current).add(session.sessionId));
    }

    try {
      const loaded = await invoke<LoadSessionResult>("grok_load_session", {
        sessionId: session.sessionId,
      });
      const alreadyCached = Boolean(sessionViewsRef.current[session.sessionId]);
      const replay = alreadyCached
        ? undefined
        : sessionReplayProjection(loaded.connection.sessionId, loaded.updates);
      upsertSessionView(
        loaded.connection,
        replay?.messages,
        replay,
      );
      if (replay?.title || replay?.updatedAt) {
        setSessionHistory((current) => current.map((entry) => entry.sessionId === session.sessionId
          ? {
              ...entry,
              title: replay.title ?? entry.title,
              updatedAt: replay.updatedAt ?? entry.updatedAt,
            }
          : entry));
      }
      if (activeSessionIdRef.current === session.sessionId) {
        setWorkspace(loaded.connection.workspace);
        setApprovalMode(loaded.connection.approvalMode);
      }
      void invoke("grok_activate_session", {
        sessionId: activeSessionIdRef.current,
      }).catch(() => undefined);
      setStatus((current) => current ? {
        ...current,
        stage: "connected",
        cliVersion: loaded.connection.cliVersion,
      } : current);
      setStage("connected");
      void refreshSessionHistory();
    } catch (error) {
      const message = String(error);
      const authRequired = message.includes(AUTH_REQUIRED_ERROR);
      if (activeSessionIdRef.current === session.sessionId) {
        activateSession(previousSessionId);
        const previous = previousSessionId ? sessionViewsRef.current[previousSessionId] : undefined;
        setWorkspace(previous?.connection.workspace ?? workspace);
        setApprovalMode(previous?.connection.approvalMode ?? "ask");
        setSetupError(authRequired ? null : message);
        setStage(authRequired ? "needsAuth" : previousSessionId ? "connected" : "ready");
      } else {
        void invoke("grok_activate_session", {
          sessionId: activeSessionIdRef.current,
        }).catch(() => undefined);
      }
    } finally {
      setLoadingSessionIds((current) => {
        const next = new Set(current);
        next.delete(session.sessionId);
        return next;
      });
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
        await invoke("grok_deactivate_session", { sessionId: connection?.sessionId }).catch(() => undefined);
        activateSession(null);
        setPendingDraft("");
        setPendingAttachments([]);
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
    const affectedSessionIds = sessionHistory
      .filter((session) =>
        target.sessionId === session.sessionId
        || (target.workspace !== undefined && target.workspace === session.workspace)
      )
      .map((session) => session.sessionId);
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
      if (action === "delete") {
        const nextViews = Object.fromEntries(
          Object.entries(sessionViewsRef.current)
            .filter(([sessionId]) => !affectedSessionIds.includes(sessionId)),
        );
        sessionViewsRef.current = nextViews;
        setSessionViews(nextViews);
        affectedSessionIds.forEach((sessionId) => activeAssistantIds.current.delete(sessionId));
      }
      if (affectsActive && action !== "restore") {
        activateSession(null);
        setPendingDraft("");
        setPendingAttachments([]);
        setApprovalMode("ask");
        setStage("ready");
      }
    } catch (error) {
      setConnectionNotice(String(error));
    } finally {
      setHistoryMutating(false);
    }
  }

  function startSessionRename(sessionId: string) {
    setSidebarMenu(null);
    setConnectionNotice(null);
    setEditingSessionId(sessionId);
  }

  async function renameSession(sessionId: string, title: string) {
    if (renamingSessionId !== null) return;
    const normalizedTitle = title.trim().replace(/\s+/g, " ");
    const session = sessionHistory.find((candidate) => candidate.sessionId === sessionId);
    if (!normalizedTitle) {
      setConnectionNotice("Enter a session name.");
      return;
    }
    if (!session) {
      setEditingSessionId(null);
      setConnectionNotice("That session is no longer in Groky history.");
      return;
    }
    if (normalizedTitle === session.title) {
      setEditingSessionId(null);
      return;
    }

    setRenamingSessionId(sessionId);
    setConnectionNotice(null);
    try {
      const renamed = await invoke<PersistedSessionSummary>("grok_rename_session", {
        sessionId,
        title: normalizedTitle,
      });
      setSessionHistory((current) => current.map((candidate) =>
        candidate.sessionId === renamed.sessionId ? renamed : candidate
      ));
      setEditingSessionId(null);
    } catch (error) {
      setConnectionNotice(String(error));
    } finally {
      setRenamingSessionId(null);
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
    setActiveView("session");
    const previousSessionId = connection?.sessionId;
    activateSession(null);
    setPendingDraft("");
    setPendingAttachments([]);
    if (connection) {
      void invoke("grok_deactivate_session", { sessionId: previousSessionId }).catch(() => undefined);
    }
    if (targetWorkspace) {
      setCollapsedWorkspaces((current) => {
        const next = new Set(current);
        next.delete(targetWorkspace);
        return next;
      });
    }
    setApprovalMode(nextMode);
    setSetupError(null);
    setConnectionNotice(null);
    setWorkspace(targetWorkspace);
    setStage("ready");
  }

  async function changeApprovalMode(nextMode: ApprovalMode) {
    if (
      nextMode === approvalMode
      || activeApprovalModeChanging
      || running
      || appUpdating
      || stage === "connecting"
    ) return;
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      setApprovalMode(nextMode);
      return;
    }

    const activeConnection = connection ?? await reconnectActiveSession();
    if (!activeConnection || activeConnection.sessionId !== sessionId) return;

    const previousMode = activeConnection.approvalMode;
    connectionTransitioning.current = true;
    setApprovalModeChangingIds((current) => new Set(current).add(sessionId));
    setConnectionNotice(null);
    updateSessionView(sessionId, (session) => ({
      ...session,
      connection: { ...session.connection, approvalMode: nextMode },
    }));
    if (activeSessionIdRef.current === sessionId) setApprovalMode(nextMode);
    try {
      const switched = await invoke<Connection>("grok_set_approval_mode", {
        sessionId,
        approvalMode: nextMode,
      });
      upsertSessionView(switched);
      if (activeSessionIdRef.current === sessionId) {
        setWorkspace(switched.workspace);
        setApprovalMode(switched.approvalMode);
      }
    } catch (error) {
      updateSessionView(sessionId, (session) => ({
        ...session,
        connection: { ...session.connection, approvalMode: previousMode },
      }));
      if (activeSessionIdRef.current === sessionId) setApprovalMode(previousMode);
      setConnectionNotice(String(error));
    } finally {
      connectionTransitioning.current = false;
      setApprovalModeChangingIds((current) => {
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
    }
  }

  async function reconnectActiveSession() {
    const currentSession = activeSessionIdRef.current
      ? sessionViewsRef.current[activeSessionIdRef.current]
      : undefined;
    if (!currentSession) return null;
    if (!currentSession.disconnected) return currentSession.connection;

    const sessionId = currentSession.connection.sessionId;
    connectionTransitioning.current = true;
    setLoadingSessionIds((current) => new Set(current).add(sessionId));
    try {
      const loaded = await invoke<LoadSessionResult>("grok_load_session", { sessionId });
      upsertSessionView(loaded.connection);
      setWorkspace(loaded.connection.workspace);
      setApprovalMode(loaded.connection.approvalMode);
      setConnectionNotice(null);
      return loaded.connection;
    } catch (error) {
      setConnectionNotice(String(error));
      return null;
    } finally {
      connectionTransitioning.current = false;
      setLoadingSessionIds((current) => {
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
    }
  }

  async function ensureSessionForSubmission() {
    if (!activeSessionIdRef.current) return createSessionForSubmission();
    return reconnectActiveSession();
  }

  async function loadModels() {
    if (pendingModels) return true;
    setConnectionNotice(null);
    try {
      const models = await invoke<SessionModelState | null>("grok_list_models", {
        workspace,
        approvalMode,
      });
      if (models) setPendingModels(models);
      return true;
    } catch (error) {
      const message = String(error);
      const authRequired = message.includes(AUTH_REQUIRED_ERROR);
      setConnectionNotice(authRequired ? null : message);
      if (authRequired) setStage("needsAuth");
      return false;
    }
  }

  async function changeModel(modelId: string) {
    const sessionId = connection?.sessionId;
    if (!sessionId) {
      if (!pendingModels) return null;
      const models = selectModelInState(pendingModels, modelId);
      setPendingModels(models);
      return models;
    }
    setConnectionNotice(null);
    try {
      const models = await invoke<SessionModelState>("grok_set_model", { sessionId, modelId });
      updateSessionView(sessionId, (session) => ({
        ...session,
        connection: { ...session.connection, models },
      }));
      setPendingModels(models);
      return models;
    } catch (error) {
      setConnectionNotice(String(error));
      return null;
    }
  }

  async function changeReasoningEffort(reasoningEffort: string) {
    const sessionId = connection?.sessionId;
    if (!sessionId) {
      if (!pendingModels) return null;
      const models = selectReasoningInState(pendingModels, reasoningEffort);
      setPendingModels(models);
      return models;
    }
    setConnectionNotice(null);
    try {
      const models = await invoke<SessionModelState>("grok_set_reasoning_effort", { sessionId, reasoningEffort });
      updateSessionView(sessionId, (session) => ({
        ...session,
        connection: { ...session.connection, models },
      }));
      setPendingModels(models);
      return models;
    } catch (error) {
      setConnectionNotice(String(error));
      return null;
    }
  }

  async function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = draft.trim();
    const sentAttachments = attachments;
    if (
      (!prompt && sentAttachments.length === 0)
      || running
      || appUpdating
      || sessionTransitioning
      || activeApprovalModeChanging
    ) return;

    const activeConnection = await ensureSessionForSubmission();
    if (!activeConnection) return;

    setSessionHistory((current) => current
      .map((session) => session.sessionId === activeConnection.sessionId
        ? {
            ...session,
            title: session.title === "New Grok session"
              ? titleFromPrompt(prompt || sentAttachments[0].name)
              : session.title,
            updatedAt: Date.now(),
            unread: false,
          }
        : session)
      .sort((left, right) => right.updatedAt - left.updatedAt));

    const userMessage: ConversationMessage = {
      id: makeMessageId("user"),
      role: "user",
      text: prompt,
      attachments: sentAttachments.map(({ name, size, mimeType }) => ({ name, size, mimeType })),
    };
    const startedAt = Date.now();
    const assistantMessage: ConversationMessage = {
      id: makeMessageId("assistant"),
      role: "assistant",
      text: "",
      startedAt,
      timeline: [{
        id: makeMessageId("thought"),
        kind: "thought",
        text: "",
        open: true,
        startedAt,
      }],
      state: "streaming",
    };
    const sessionId = activeConnection.sessionId;
    activeAssistantIds.current.set(sessionId, assistantMessage.id);
    setSessionMessages(sessionId, (current) => [...current, userMessage, assistantMessage]);
    updateSessionView(sessionId, (session) => ({
      ...session,
      draft: "",
      attachments: [],
      running: true,
    }));

    try {
      const result = await invoke<PromptResult>("grok_prompt", {
        sessionId,
        prompt,
        attachmentPaths: sentAttachments.map((attachment) => attachment.path),
      });
      const endedAt = Date.now();
      setSessionMessages(sessionId, (current) => current.map((message) =>
        message.id === assistantMessage.id ? (() => {
          const state = stateFromStopReason(result.stopReason);
          const finished = reconcileFallbackResponse(
            addFallbackThought(finishRun(message, endedAt, terminalToolStatus(state)), result.thought),
            result.text,
          );
          return {
            ...finished,
            state,
            stopReason: result.stopReason,
            error: state === "error" ? "Grok Build ended the turn for an unknown reason." : message.error,
          };
        })() : message
      ));
    } catch (error) {
      const endedAt = Date.now();
      setSessionMessages(sessionId, (current) => current.map((message) =>
        message.id === assistantMessage.id
          ? { ...finishRun(message, endedAt, "failed"), state: "error", error: String(error) }
          : message
      ));
    } finally {
      setSessionRunning(sessionId, false);
      activeAssistantIds.current.delete(sessionId);
      const unread = activeSessionIdRef.current !== sessionId;
      setSessionHistory((current) => current.map((session) => session.sessionId === sessionId
        ? { ...session, unread }
        : session));
      void refreshSessionHistory();
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;

    if (commandSuggestions.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setActiveCommandSuggestion((current) => (
          current + direction + commandSuggestions.length
        ) % commandSuggestions.length);
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        setActiveCommandSuggestion(event.key === "Home" ? 0 : commandSuggestions.length - 1);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || (event.key === "Tab" && !event.shiftKey)) {
        event.preventDefault();
        selectAvailableCommand(commandSuggestions[activeCommandSuggestion] ?? commandSuggestions[0]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setCommandSuggestionsOpen(false);
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  async function loadCommandCatalogForComposer() {
    if (!isTauri() || activeSessionIdRef.current) return;
    const key = workspace ?? "__standalone__";
    const hasCachedCatalog = commandCatalogs[key] !== undefined
      || Object.values(sessionViewsRef.current).some((session) => session.connection.workspace === workspace);
    const requestKey = `${approvalMode}:${key}`;
    if (hasCachedCatalog || commandCatalogRequests.current.has(requestKey)) return;

    commandCatalogRequests.current.add(requestKey);
    try {
      const commands = await invoke<AvailableCommand[]>("grok_list_commands", {
        workspace,
        approvalMode,
      });
      setCommandCatalogs((current) => ({ ...current, [key]: commands }));
    } catch (error) {
      setConnectionNotice(String(error));
    } finally {
      commandCatalogRequests.current.delete(requestKey);
    }
  }

  function handleComposerChange(nextDraft: string) {
    setDraft(nextDraft);
    if (commandTokenAtEnd(nextDraft) && !connection) {
      void loadCommandCatalogForComposer();
    }
  }

  function selectAvailableCommand(command: AvailableCommand) {
    const token = commandTokenAtEnd(draft);
    if (!token) return;
    const nextDraft = `${draft.slice(0, token.start)}/${command.name}${command.inputHint ? " " : ""}`;
    setDraft(nextDraft);
    setCommandSuggestionsOpen(false);
    window.requestAnimationFrame(() => {
      const textarea = composerTextarea.current;
      textarea?.focus();
      textarea?.setSelectionRange(nextDraft.length, nextDraft.length);
    });
  }

  async function cancelRun() {
    const sessionId = connection?.sessionId;
    if (!sessionId) return;
    try {
      await invoke("grok_cancel", { sessionId });
      const messageId = activeAssistantIds.current.get(sessionId);
      const endedAt = Date.now();
      setSessionMessages(sessionId, (current) => current.map((message) =>
        message.id === messageId
          ? {
              ...finishRun(message, endedAt, "cancelled"),
              state: "cancelled" as const,
              stopReason: "cancelled" as const,
            }
          : message
      ));
    } catch (error) {
      setConnectionNotice(String(error));
    }
  }

  async function respondToPermission(optionId: string | null) {
    if (!permission) return;
    const current = permission;
    const selectedOption = current.options.find((option) => option.optionId === optionId);
    setRespondingPermissionId(current.requestId);
    try {
      await invoke("grok_respond_permission", {
        sessionId: current.sessionId,
        requestId: current.requestId,
        optionId,
      });
      resolveSessionPermission(current.sessionId, current.requestId);
      if (enablesAlwaysApprove(selectedOption)) {
        setApprovalMode("alwaysApprove");
        updateSessionView(current.sessionId, (session) => ({
          ...session,
          connection: { ...session.connection, approvalMode: "alwaysApprove" },
        }));
      }
    } catch (error) {
      setConnectionNotice(String(error));
    } finally {
      setRespondingPermissionId(null);
    }
  }

  async function signOut() {
    setShowConnection(false);
    setActiveView("session");
    clearAllSessionViews();
    setPendingDraft("");
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

  const authenticated = ["ready", "connecting", "connected"].includes(stage);
  const appNotice = connectionNotice ?? setupError;

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
      </>
    );
  }

  return (
    <>
      <div
        className={`app-shell ${overlayTitlebar ? "has-overlay-titlebar" : ""} ${activeView === "settings" ? "settings-open" : "session-shell"} ${activeView === "session" && sidebarCollapsed ? "sidebar-collapsed" : ""} ${activeView === "session" && sidePanelOpen ? "right-panel-open" : ""}`}
        inert={globalSearchOpen}
        style={{
          "--sidebar-width": `${sidebarWidth}px`,
          "--side-panel-width": `${sidePanelWidth}px`,
          ...(overlayTitlebar && nativeTitlebarHeight !== null
            ? { "--app-header-height": `${nativeTitlebarHeight}px` }
            : {}),
        } as CSSProperties}
      >
      {activeView === "settings" ? (
        <SettingsSidebar
          overlayTitlebar={overlayTitlebar}
          section={activeSettingsSection}
          onSectionChange={setActiveSettingsSection}
          onBack={() => setActiveView("session")}
        />
      ) : (
      <aside className="sidebar">
        <div className="window-nav" {...dragRegionProps}>
          <button className="icon-button sidebar-toggle" type="button" aria-label="Hide sidebar" title={`Hide sidebar (${sidebarShortcutLabel})`} onClick={toggleSidebar}><Icon name="panel" /></button>
        </div>

        <div className="brand-row">
          <Brand />
          <button
            className="icon-button brand-search"
            type="button"
            aria-label="Search sessions and actions"
            aria-haspopup="dialog"
            aria-expanded={globalSearchOpen}
            title={`Search sessions and actions (${searchShortcutLabel})`}
            onClick={openGlobalSearch}
          >
            <Icon name="search" size={18} />
          </button>
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
                            selected={activeSessionId === session.sessionId}
                            disabled={sidebarActionsDisabled}
                            editing={editingSessionId === session.sessionId}
                            renaming={renamingSessionId === session.sessionId}
                            menuOpen={sidebarMenu?.kind === "session" && sidebarMenu.sessionId === session.sessionId}
                            onSelect={() => void loadSession(session)}
                            onToggleMenu={() => setSidebarMenu((current) =>
                              current?.kind === "session" && current.sessionId === session.sessionId
                                ? null
                                : { kind: "session", sessionId: session.sessionId }
                            )}
                            onStartRename={() => startSessionRename(session.sessionId)}
                            onRename={(title) => void renameSession(session.sessionId, title)}
                            onCancelRename={() => setEditingSessionId(null)}
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
                    selected={activeSessionId === session.sessionId}
                    disabled={sidebarActionsDisabled}
                    editing={editingSessionId === session.sessionId}
                    renaming={renamingSessionId === session.sessionId}
                    menuOpen={sidebarMenu?.kind === "session" && sidebarMenu.sessionId === session.sessionId}
                    onSelect={() => void loadSession(session)}
                    onToggleMenu={() => setSidebarMenu((current) =>
                      current?.kind === "session" && current.sessionId === session.sessionId
                        ? null
                        : { kind: "session", sessionId: session.sessionId }
                    )}
                    onStartRename={() => startSessionRename(session.sessionId)}
                    onRename={(title) => void renameSession(session.sessionId, title)}
                    onCancelRename={() => setEditingSessionId(null)}
                    onArchive={() => void mutateSessionHistory("archive", { sessionId: session.sessionId })}
                    onRestore={() => void mutateSessionHistory("restore", { sessionId: session.sessionId })}
                    onDelete={() => requestSessionDelete(session)}
                  />
                ))}
              </div>
            </section>
          )}

        </div>

        {appUpdate && (
          <SidebarUpdateCard
            update={appUpdate}
            phase={updatePhase}
            progress={updateProgress}
            error={updateError}
            taskRunning={anySessionRunning}
            onInstall={() => void installAppUpdate()}
          />
        )}

        <button
          className="profile-row"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={showConnection}
          data-connection-popover-root
          onClick={() => setShowConnection((current) => !current)}
        >
          <span className="avatar" aria-hidden="true">{accountAvatarLabel(accountProfile)}</span>
          <span className="profile-copy">
            <strong>{accountName}</strong>
            <small title={accountDetail}>{accountDetail}</small>
          </span>
          {connection && <span className="connection-pill">live</span>}
        </button>

        {showConnection && (
          <div className="connection-popover" role="dialog" aria-label="Grok Build statistics and account" data-connection-popover-root>
            <dl>
              <div><dt>Groky</dt><dd>{appVersion ? `Version ${appVersion}` : "Version unavailable"}</dd></div>
              <div><dt>Engine</dt><dd>{connection?.cliVersion ?? status?.cliVersion ?? "Grok Build"}</dd></div>
            </dl>
            <button
              className="popover-settings-link popover-usage-link"
              type="button"
              onClick={() => void openUsageDetails()}
            >
              <Icon name="gauge" size={14} />
              <span>Usage &amp; limits</span>
              <span className="popover-settings-arrow"><Icon name="external-link" size={12} /></span>
            </button>
            <button
              className="popover-settings-link"
              type="button"
              onClick={() => {
                setShowConnection(false);
                setSidebarMenu(null);
                setActiveSettingsSection("application");
                setActiveView("settings");
              }}
            >
              <Icon name="sliders" size={14} />
              <span>Settings</span>
              <span className="popover-settings-arrow"><Icon name="arrow-right" size={12} /></span>
            </button>
            <div className={`popover-update ${appUpdate ? "available" : ""}`}>
              <button
                type="button"
                onClick={appUpdate ? () => void installAppUpdate() : () => void checkForAppUpdate(true)}
                disabled={updatePhase === "checking" || updatePhase === "downloading" || (appUpdate !== null && anySessionRunning)}
              >
                <Icon name={appUpdate ? "download" : "refresh"} size={13} />
                {appUpdate
                  ? updatePhase === "downloading"
                    ? "Updating…"
                    : anySessionRunning
                      ? "Finish current turn first"
                      : "Update & restart"
                  : updatePhase === "checking"
                    ? "Checking…"
                    : "Check now"}
              </button>
              <small aria-live="polite">{appUpdate
                ? `Version ${appUpdate.version} was found automatically.`
                : updateCheckNotice ?? "Automatic update checks are on."}</small>
            </div>
            <div className="popover-actions">
              <button className="danger-action" type="button" onClick={() => void signOut()}><Icon name="logout" size={14} /> Sign out</button>
            </div>
          </div>
        )}
      </aside>
      )}

      {activeView === "session" && !sidebarCollapsed && (
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
        {activeView === "settings" ? (
          <SettingsScreen
            overlayTitlebar={overlayTitlebar}
            section={activeSettingsSection}
            appVersion={appVersion}
            cliVersion={connection?.cliVersion ?? status?.cliVersion ?? null}
            connected={connection !== null}
            currentModeId={activeSession?.currentModeId ?? null}
            configOptions={activeSession?.configOptions ?? []}
            usage={activeSession?.usage ?? null}
            update={appUpdate}
            updatePhase={updatePhase}
            updateNotice={updateCheckNotice}
            taskRunning={anySessionRunning}
            archivedSessions={archivedSidebarSessions}
            archivedActionsDisabled={sidebarActionsDisabled}
            onCheckForUpdates={() => void checkForAppUpdate(true)}
            onInstallUpdate={() => void installAppUpdate()}
            onSignOut={() => void signOut()}
            onRestoreArchived={(sessionId) => void mutateSessionHistory("restore", { sessionId })}
            onDeleteArchived={(session) => requestSessionDelete(session)}
          />
        ) : (
        <>
        {fileDragActive && (
          <div className="file-drop-overlay" role="status" aria-live="polite">
            <span className="file-drop-glyph"><Icon name="paperclip" size={24} /></span>
            <strong>Drop to attach</strong>
            <small>{fileDragCount === 1 ? "1 file ready" : `${fileDragCount || "Multiple"} files ready`}</small>
          </div>
        )}
        <header className="taskbar" {...dragRegionProps}>
          <div className="taskbar-leading">
            {sidebarCollapsed && (
              <button className="icon-button sidebar-restore" type="button" aria-label="Show sidebar" title={`Show sidebar (${sidebarShortcutLabel})`} onClick={toggleSidebar}><Icon name="panel" /></button>
            )}
            <div className="task-title workspace-context">
              <Icon name={sessionWorkspace ? "folder" : "standalone"} />
              <strong title={activeSessionTitle}>{activeSessionTitle}</strong>
              <span
                className="local-chip"
                title={sessionWorkspace ?? "Standalone"}
              >
                <span className="local-chip-label">{sessionWorkspace ? projectName : "Standalone"}</span>
              </span>
            </div>
          </div>
          <div className="task-actions">
            <span className={`agent-state ${running ? "working" : ""}`}>
              <span className="live-dot" />
              {running ? (
                <>
                  <span>Grok is working</span>
                  {activeRunStartedAt !== undefined && (
                    <DurationText
                      timing={{ startedAt: activeRunStartedAt }}
                      active
                      className="agent-elapsed"
                      label="Turn elapsed time"
                      prefix="· "
                    />
                  )}
                </>
              ) : connection ? "ACP connected" : "Signed in"}
            </span>
          </div>
        </header>

        {appNotice && (
          <div className="connection-banner" role="alert">
            <span>{appNotice}</span>
            {activeSession?.disconnected && (
              <button type="button" onClick={() => void reconnectActiveSession()}>Reconnect</button>
            )}
            <button className="icon-button" type="button" aria-label="Dismiss" onClick={() => { setConnectionNotice(null); setSetupError(null); }}><Icon name="x" size={15} /></button>
          </div>
        )}

        <section
          id="task-conversation"
          ref={conversation}
          className={`conversation ${messages.length === 0 ? "empty" : ""} ${messageHistory.length >= 2 ? "has-message-history" : ""}`}
          aria-label="Session conversation"
          onScroll={handleConversationScroll}
        >
          <div ref={conversationContent} className="conversation-inner">
            {!activeSessionLoading && (messages.length === 0 ? (
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
            )))}

            {permission && (
              <PermissionCard
                permission={permission}
                busy={respondingPermissionId === permission.requestId}
                onRespond={(optionId) => void respondToPermission(optionId)}
              />
            )}
          </div>
        </section>

        <MessageHistoryNav
          turns={messageHistory}
          activeId={activeHistoryMessageId}
          onNavigate={scrollToHistoryMessage}
        />

        <div ref={composerDock} className="composer-dock">
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

          {sessionLocationEditable && (
            <section className="session-start-config" aria-label="Session location">
              <SessionLocationSelector
                value={workspace}
                workspaces={workspaceGroups.map((group) => group.path)}
                disabled={sidebarActionsDisabled}
                onChange={selectPendingSessionLocation}
                onAddWorkspace={chooseAndAddWorkspace}
              />
            </section>
          )}
          <form className={`composer approval-mode-${approvalMode} ${running ? "is-running" : ""}`} onSubmit={submitTask}>
          {plan.length > 0 && <PlanBlock entries={plan} active={running} />}
          {attachments.length > 0 && (
            <div className="attachment-tray" aria-label="Files attached to this message">
              {attachments.map((attachment) => (
                <div className="attachment-chip" key={attachment.path}>
                  <span className="attachment-chip-icon"><Icon name="paperclip" size={13} /></span>
                  <span className="attachment-chip-copy">
                    <strong>{attachment.name}</strong>
                    <small>{formatFileSize(attachment.size)}</small>
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.name}`}
                    disabled={attachmentDisabled}
                    onClick={() => setAttachments(attachments.filter((item) => item.path !== attachment.path))}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {commandSuggestions.length > 0 && (
            <div
              ref={commandSuggestionsList}
              className="command-suggestions"
              id={commandSuggestionsId}
              role="listbox"
              aria-label="Available Grok commands"
            >
              <div className="command-suggestions-heading">
                <span className="command-suggestions-label">COMMANDS</span>
                <small>{commandSuggestions.length} available</small>
              </div>
              {commandSuggestions.map((command, index) => (
                <button
                  type="button"
                  role="option"
                  id={`${commandSuggestionsId}-option-${index}`}
                  key={command.name}
                  data-command-index={index}
                  aria-selected={index === activeCommandSuggestion}
                  tabIndex={-1}
                  onPointerMove={() => setActiveCommandSuggestion(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectAvailableCommand(command)}
                >
                  <code>/{command.name}</code>
                  <span>{command.description}</span>
                  {command.inputHint && <small>{command.inputHint}</small>}
                </button>
              ))}
              <div className="command-suggestions-help" aria-hidden="true">
                <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
                <span><kbd>Enter</kbd> choose</span>
                <span><kbd>Esc</kbd> close</span>
              </div>
            </div>
          )}
          <div className="prompt-row">
            <span className="prompt-symbol" aria-hidden="true">❯</span>
            <textarea
              ref={composerTextarea}
              aria-label="Session prompt"
              value={draft}
              onChange={(event) => handleComposerChange(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              aria-autocomplete="list"
              aria-controls={commandSuggestions.length > 0 ? commandSuggestionsId : undefined}
              aria-expanded={commandSuggestions.length > 0}
              aria-activedescendant={commandSuggestions.length > 0
                ? `${commandSuggestionsId}-option-${activeCommandSuggestion}`
                : undefined}
              placeholder={appUpdating ? "Groky is installing an update…" : running ? "Grok is working…" : "Ask Groky to build, debug, or review"}
              rows={2}
              disabled={running || appUpdating || sessionTransitioning}
            />
          </div>
          <div className="composer-toolbar">
            <button
              className="icon-button attachment-button add-context"
              type="button"
              aria-label="Attach files"
              title="Attach files"
              aria-busy={attachmentBusy}
              disabled={attachmentDisabled || attachmentBusy}
              onClick={() => void chooseAttachmentFiles()}
            >
              <Icon name="paperclip" size={16} />
            </button>
            <ApprovalModeSelector
              mode={approvalMode}
              busy={running || appUpdating || sessionTransitioning}
              changing={activeApprovalModeChanging}
              onChange={(nextMode) => void changeApprovalMode(nextMode)}
            />
            <span className="toolbar-spacer" />
            <ModelSelector
              connected={connection !== null}
              models={connection?.models ?? pendingModels}
              busy={running || appUpdating || sessionTransitioning || activeApprovalModeChanging}
              onLoad={loadModels}
              onChange={changeModel}
              onReasoningChange={changeReasoningEffort}
            />
            {running ? (
              <button className="send-button stop-button" type="button" aria-label="Stop" onClick={() => void cancelRun()}><Icon name="stop" size={15} /></button>
            ) : (
              <button className="send-button" type="submit" aria-label="Send" disabled={(!draft.trim() && attachments.length === 0) || appUpdating || sessionTransitioning || activeApprovalModeChanging}><Icon name="arrow-up" size={17} /></button>
            )}
          </div>
          </form>
        </div>
        </>
        )}
      </main>
      {activeView === "session" && sidePanelOpen && (
          <div
            className="side-panel-resizer"
            role="separator"
            aria-label="Resize tools panel"
            aria-orientation="vertical"
            aria-valuemin={MIN_SIDE_PANEL_WIDTH}
            aria-valuemax={MAX_SIDE_PANEL_WIDTH}
            aria-valuenow={Math.round(sidePanelWidth)}
            tabIndex={0}
            onDoubleClick={() => setSidePanelWidth(defaultSidePanelWidth())}
            onKeyDown={resizeSidePanelWithKeyboard}
            onPointerDown={startSidePanelResize}
            onPointerMove={resizeSidePanel}
            onPointerUp={finishSidePanelResize}
            onPointerCancel={finishSidePanelResize}
          />
      )}
      {activeView === "session" && sidePanelMounted && (
        <TerminalPanel
          open={sidePanelOpen}
          sessionId={activeSession?.connection.sessionId ?? null}
          workingDirectory={activeSession?.connection.workingDirectory ?? workspace}
          attachmentDisabled={attachmentDisabled || attachments.length >= MAX_MESSAGE_ATTACHMENTS}
          onAttach={addWorkspaceAttachment}
        />
      )}
      {activeView === "session" && (
        <button
          className="icon-button tools-panel-toggle"
          type="button"
          aria-label={sidePanelOpen ? "Close tools panel" : "Open tools panel"}
          aria-controls="tools-panel"
          aria-expanded={sidePanelOpen}
          title={`${sidePanelOpen ? "Close" : "Open"} tools panel (${sidePanelShortcutLabel})`}
          onClick={toggleSidePanel}
        >
          <Icon name="panel" size={16} />
        </button>
      )}
      </div>
      <GlobalSearchDialog
        open={globalSearchOpen}
        sessions={activeSidebarSessions}
        activeSessionId={activeSessionId}
        archivedCount={archivedSidebarSessions.length}
        actionsDisabled={sidebarActionsDisabled}
        shortcutLabel={searchShortcutLabel}
        onClose={() => setGlobalSearchOpen(false)}
        onSelectSession={(sessionId) => {
          const session = sessionHistory.find((entry) => entry.sessionId === sessionId);
          if (session) void loadSession(session);
        }}
        onNewSession={() => void startNewTask()}
        onAddWorkspace={() => void chooseAndAddWorkspace()}
        onOpenSettings={() => {
          setActiveSettingsSection("application");
          setActiveView("settings");
        }}
        onOpenArchived={() => {
          setActiveSettingsSection("archived");
          setActiveView("settings");
        }}
      />
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
    </>
  );
}

function ThoughtBlock({
  thought,
  active,
  startedAt,
  endedAt,
  elapsedMs,
}: {
  thought: string;
  active: boolean;
  startedAt?: number;
  endedAt?: number;
  elapsedMs?: number;
}) {
  const [open, setOpen] = useState(active);
  const contentId = useId();
  const label = active
    ? (
        <>
          <span>Thinking</span>
          <DurationText
            timing={{ startedAt, endedAt, elapsedMs }}
            active
            label="Thought elapsed time"
            prefix=" · "
            formatter={formatThoughtDuration}
          />
        </>
      )
    : elapsedMs === undefined
      ? "Thought"
      : `Thought for ${formatThoughtDuration(elapsedMs)}`;

  useEffect(() => {
    setOpen(active);
  }, [active]);

  if (!active && !thought.trim()) return null;

  return (
    <div className="thought-block" data-active={active} data-open={open}>
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
        <div>{thought && <p>{thought}</p>}</div>
      </div>
    </div>
  );
}

function PlanBlock({ entries, active }: { entries: PlanEntry[]; active: boolean }) {
  const [open, setOpen] = useState(active);
  const contentId = useId();
  const current = entries.find((entry) => entry.status === "in_progress")
    ?? entries.find((entry) => entry.status === "pending");
  const completed = entries.filter((entry) => entry.status === "completed").length;
  const summary = active && current
    ? current.content
    : `${completed}/${entries.length} plan steps complete`;

  useEffect(() => {
    if (active) setOpen(true);
    else if (completed === entries.length) setOpen(false);
  }, [active, completed, entries.length]);

  return (
    <div className="progress-disclosure plan-disclosure" data-open={open}>
      <button type="button" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen((value) => !value)}>
        <span className="progress-disclosure-label"><Icon name="chevron-down" size={13} /> PLAN</span>
        <span className="progress-disclosure-summary">{summary}</span>
      </button>
      <div className="progress-disclosure-content" id={contentId} aria-hidden={!open}>
        <div>
          {entries.map((entry, index) => (
            <div className="plan-row" key={`${entry.content}-${index}`}>
              <i className={entry.status} />
              <span>{entry.content}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function fileNameFromPath(path: string) {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function formatTokenCount(value: number) {
  return new Intl.NumberFormat("en", { notation: value >= 10_000 ? "compact" : "standard" }).format(value);
}

type ToolVerbGroupKind = "file" | "skill" | "pattern" | "dir" | "web_fetch" | "web_search" | "memory" | "integration";

type ProjectedTimelineItem = TurnTimelineItem | {
  id: string;
  kind: "tool_group";
  tools: ToolActivity[];
};

type ResponseTimelineItem = Extract<ProjectedTimelineItem, { kind: "response" }>;
type TraceTimelineItem = Exclude<ProjectedTimelineItem, ResponseTimelineItem>;
type TimelineSection =
  | { id: string; kind: "response"; item: ResponseTimelineItem }
  | { id: string; kind: "trace"; items: TraceTimelineItem[] };

function toolVerbGroupKind(tool: ToolActivity): ToolVerbGroupKind | null {
  const title = tool.title.toLocaleLowerCase();
  if (tool.kind === "read") return /(?:^|[\\/])skills?(?:[\\/]|$)|skill\.md/.test(title) ? "skill" : "file";
  if (tool.kind === "fetch") return "web_fetch";
  if (tool.kind === "search") return /\b(web|x)\s*search\b|search(?:ing)? the web/.test(title) ? "web_search" : "pattern";
  if (/\b(list[_ -]?dir|list directory|listing directory)\b/.test(title)) return "dir";
  if (/\b(memory[_ -]?search|search(?:ing)? memor)/.test(title)) return "memory";
  if (/\b(search[_ -]?tool|integration search|search(?:ing)? mcp)/.test(title)) return "integration";
  if (/\b(skill|skill\.md)\b/.test(title)) return "skill";
  return null;
}

function projectTimeline(timeline: TurnTimelineItem[]): ProjectedTimelineItem[] {
  const projected: ProjectedTimelineItem[] = [];
  timeline.forEach((item) => {
    if (item.kind !== "tool" || toolVerbGroupKind(item.tool) === null) {
      projected.push(item);
      return;
    }
    const last = projected[projected.length - 1];
    if (last?.kind === "tool_group") {
      last.tools.push(item.tool);
      return;
    }
    projected.push({ id: `tool-group-${item.id}`, kind: "tool_group", tools: [item.tool] });
  });
  return projected;
}

function sectionTimeline(timeline: ProjectedTimelineItem[]): TimelineSection[] {
  const sections: TimelineSection[] = [];
  timeline.forEach((item) => {
    if (item.kind === "response") {
      sections.push({ id: item.id, kind: "response", item });
      return;
    }
    const last = sections[sections.length - 1];
    if (last?.kind === "trace") {
      last.items.push(item);
      return;
    }
    sections.push({ id: `trace-${item.id}`, kind: "trace", items: [item] });
  });
  return sections;
}

const TOOL_GROUP_WORDS: Record<ToolVerbGroupKind, { past: string; present: string; one: string; many: string }> = {
  file: { past: "Read", present: "Reading", one: "file", many: "files" },
  skill: { past: "Read", present: "Reading", one: "skill", many: "skills" },
  pattern: { past: "Searched", present: "Searching", one: "pattern", many: "patterns" },
  dir: { past: "Listed", present: "Listing", one: "dir", many: "dirs" },
  web_fetch: { past: "Fetched", present: "Fetching", one: "website", many: "websites" },
  web_search: { past: "Searched", present: "Searching", one: "website", many: "websites" },
  memory: { past: "Searched", present: "Searching", one: "memory", many: "memories" },
  integration: { past: "Searched", present: "Searching", one: "MCP tool", many: "MCP tools" },
};

function toolGroupSummary(tools: ToolActivity[]) {
  const running = tools.some((tool) => tool.status === "pending" || tool.status === "in_progress");
  const buckets = new Map<ToolVerbGroupKind, number>();
  tools.forEach((tool) => {
    const kind = toolVerbGroupKind(tool);
    if (kind) buckets.set(kind, (buckets.get(kind) ?? 0) + 1);
  });
  const summary = Array.from(buckets, ([kind, count]) => {
    const words = TOOL_GROUP_WORDS[kind];
    return `${running ? words.present : words.past} ${count} ${count === 1 ? words.one : words.many}`;
  });
  const failed = tools.filter((tool) => tool.status === "failed").length;
  const cancelled = tools.filter((tool) => tool.status === "cancelled").length;
  if (failed) summary.push(`${failed} failed`);
  if (cancelled) summary.push(`${cancelled} cancelled`);
  return summary.join(", ");
}

function ToolDetailRow({ tool }: { tool: ToolActivity }) {
  const active = isActiveToolStatus(tool.status);
  return (
    <div className={`activity-row ${tool.status}`}>
      <span className="activity-icon">
        {tool.status === "completed"
          ? <Icon name="check" size={13} />
          : tool.status === "failed" || tool.status === "cancelled"
            ? <Icon name="x" size={13} />
            : <Icon name="terminal" size={13} />}
      </span>
      <span className="activity-copy">
        <strong>{tool.title}</strong>
        {tool.locations && tool.locations.length > 0 && (
          <small>{tool.locations.map((location) => fileNameFromPath(location.path)).join(", ")}</small>
        )}
      </span>
      <span className="activity-detail">
        <span>{tool.status.replace(/_/g, " ")}</span>
        <DurationText
          timing={tool}
          active={active}
          label={`${tool.title} elapsed time`}
          prefix=" · "
        />
      </span>
    </div>
  );
}

function ToolGroupBlock({ tools }: { tools: ToolActivity[] }) {
  const failed = tools.filter((tool) => tool.status === "failed");
  const cancelled = tools.filter((tool) => tool.status === "cancelled");
  const interrupted = failed.length + cancelled.length;
  const active = tools.some((tool) => isActiveToolStatus(tool.status));
  const timing = combineTimings(tools);
  const [open, setOpen] = useState(interrupted > 0);
  const contentId = useId();

  useEffect(() => {
    if (interrupted > 0) setOpen(true);
  }, [interrupted]);

  return (
    <div className={`progress-disclosure tool-group-disclosure ${interrupted > 0 ? "has-failure" : ""}`} data-open={open}>
      <button type="button" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen((value) => !value)}>
        <span className="progress-disclosure-label" aria-hidden="true"><Icon name="chevron-down" size={13} /></span>
        <span className="progress-disclosure-summary">{toolGroupSummary(tools)}</span>
        <DurationText
          timing={timing}
          active={active}
          className="trace-duration"
          label="Event group elapsed time"
        />
      </button>
      <div className="progress-disclosure-content" id={contentId} aria-hidden={!open}>
        <div>
          {tools.map((tool) => <ToolDetailRow tool={tool} key={tool.id} />)}
        </div>
      </div>
    </div>
  );
}

function ToolBlock({ tool }: { tool: ToolActivity }) {
  const interrupted = tool.status === "failed" || tool.status === "cancelled";
  const active = isActiveToolStatus(tool.status);
  const [open, setOpen] = useState(interrupted);
  const contentId = useId();
  const statusLabel = tool.status.replace(/_/g, " ");

  useEffect(() => {
    if (interrupted) setOpen(true);
  }, [interrupted]);

  return (
    <div
      className={`progress-disclosure tool-call-disclosure ${tool.status}`}
      data-open={open}
    >
      <button type="button" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen((value) => !value)}>
        <span className="progress-disclosure-label" aria-hidden="true"><Icon name="chevron-down" size={13} /></span>
        <span className="progress-disclosure-summary">{tool.title}</span>
        <span className="trace-meta">
          <DurationText
            timing={tool}
            active={active}
            className="trace-duration"
            label={`${tool.title} elapsed time`}
          />
          <span className="trace-status" aria-label={statusLabel} title={statusLabel}>
            {tool.status === "completed"
              ? <Icon name="check" size={12} />
              : interrupted
                ? <Icon name="x" size={12} />
                : <span className="trace-status-pulse" />}
          </span>
        </span>
      </button>
      <div className="progress-disclosure-content" id={contentId} aria-hidden={!open}>
        <div className="tool-call-detail">
          <code>{tool.title}</code>
          <div>
            <span>{statusLabel}</span>
            {tool.locations && tool.locations.length > 0 && (
              <small>{tool.locations.map((location) => fileNameFromPath(location.path)).join(", ")}</small>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TraceItems({ items, messageState }: { items: TraceTimelineItem[]; messageState?: ConversationState }) {
  return items.map((item) => {
    if (item.kind === "thought") {
      return (
        <ThoughtBlock
          key={item.id}
          thought={item.text}
          active={messageState === "streaming" && item.open}
          startedAt={item.startedAt}
          endedAt={item.endedAt}
          elapsedMs={item.elapsedMs}
        />
      );
    }
    if (item.kind === "tool_group") {
      return <ToolGroupBlock key={item.id} tools={item.tools} />;
    }
    if (item.kind === "tool") return <ToolBlock key={item.id} tool={item.tool} />;
    if (!item.decision) return null;
    return (
      <div className={`permission-decision ${item.decision.outcome}`} key={item.id}>
        <Icon name={item.decision.outcome === "allowed" ? "check" : "x"} size={13} />
        <span>{item.decision.label}</span>
        <small>{item.decision.title}</small>
        <DurationText timing={item} className="trace-duration" label="Permission wait time" />
      </div>
    );
  });
}

function traceGroupDetails(items: TraceTimelineItem[]) {
  let count = 0;
  let running = 0;
  let interrupted = 0;
  items.forEach((item) => {
    if (item.kind === "tool_group") {
      count += item.tools.length;
      item.tools.forEach((tool) => {
        if (tool.status === "pending" || tool.status === "in_progress") running += 1;
        if (tool.status === "failed" || tool.status === "cancelled") interrupted += 1;
      });
      return;
    }
    count += 1;
    if (item.kind === "tool") {
      if (item.tool.status === "pending" || item.tool.status === "in_progress") running += 1;
      if (item.tool.status === "failed" || item.tool.status === "cancelled") interrupted += 1;
    }
    if (item.kind === "permission" && item.decision && item.decision.outcome !== "allowed") interrupted += 1;
  });
  return { count, running, interrupted };
}

function traceItemTiming(item: TraceTimelineItem): EventTiming {
  if (item.kind === "tool_group") return combineTimings(item.tools);
  if (item.kind === "tool") return item.tool;
  return item;
}

function CollapsedTraceBlock({
  items,
  messageState,
}: {
  items: TraceTimelineItem[];
  messageState?: ConversationState;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const { count, running, interrupted } = traceGroupDetails(items);
  const timing = combineTimings(items.map(traceItemTiming));
  const active = messageState === "streaming"
    && timing.startedAt !== undefined
    && timing.endedAt === undefined;
  const summary = `${count} execution ${count === 1 ? "event" : "events"}${interrupted > 0 ? ` · ${interrupted} interrupted` : ""}`;
  const status = interrupted > 0 ? "interrupted" : running > 0 ? "in progress" : "completed";

  return (
    <div
      className={`progress-disclosure turn-trace trace-group-disclosure ${interrupted > 0 ? "has-interruption" : ""}`}
      data-open={open}
      role="group"
      aria-label="Collapsed execution trace"
    >
      <button type="button" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen((value) => !value)}>
        <span className="progress-disclosure-label" aria-hidden="true"><Icon name="chevron-down" size={13} /></span>
        <span className="progress-disclosure-summary">{summary}</span>
        <span className="trace-meta">
          <DurationText
            timing={timing}
            active={active}
            className="trace-duration"
            label="Execution group elapsed time"
          />
          <span className="trace-status" aria-label={status} title={status}>
            {interrupted > 0
              ? <Icon name="x" size={12} />
              : running > 0
                ? <span className="trace-status-pulse" />
                : <Icon name="check" size={12} />}
          </span>
        </span>
      </button>
      <div className="progress-disclosure-content" id={contentId} aria-hidden={!open}>
        <div>
          <div className="turn-trace trace-group-items">
            <TraceItems items={items} messageState={messageState} />
          </div>
        </div>
      </div>
    </div>
  );
}

function TurnStatusBlock({ message }: { message: ConversationMessage }) {
  if (!message.state || message.state === "streaming") return null;
  const duration = message.elapsedMs === undefined ? null : formatDuration(message.elapsedMs);
  const status = message.state === "cancelled"
    ? duration ? `Turn cancelled by user in ${duration}.` : "Turn cancelled by user."
    : message.state === "refused"
      ? "Grok declined this request."
      : message.state === "limited"
        ? message.stopReason === "max_tokens" ? "Stopped at the token limit." : "Stopped at the turn limit."
        : message.state === "error"
          ? message.error ?? (duration ? `Turn failed in ${duration}.` : "Turn failed.")
          : duration ? `Worked for ${duration}.` : "Turn completed.";
  const metadata = [
    message.metrics?.totalTokens != null ? `${formatTokenCount(message.metrics.totalTokens)} tokens` : null,
    message.metrics?.modelCalls != null
      ? `${message.metrics.modelCalls} ${message.metrics.modelCalls === 1 ? "model call" : "model calls"}`
      : null,
  ].filter(Boolean).join(" · ");
  return (
    <div className={`turn-status ${message.state}`}>
      <span>{status}</span>
      {metadata && <small>{metadata}</small>}
    </div>
  );
}

function ConversationItem({ message }: { message: ConversationMessage }) {
  if (message.role === "user") {
    return (
      <div className="user-message" data-history-message-id={message.id}>
        <div className="user-message-heading">
          <span className="message-kicker">REQUEST</span>
          {message.text && <MessageCopyButton text={message.text} subject="request" />}
        </div>
        {message.text && <div className="user-message-copy">{message.text}</div>}
        {message.attachments && message.attachments.length > 0 && (
          <div className="message-attachments" aria-label="Attached files">
            {message.attachments.map((attachment, index) => (
              <span className="message-attachment" key={`${attachment.name}-${index}`}>
                <Icon name="paperclip" size={12} />
                <span>{attachment.name}</span>
                <small>{formatFileSize(attachment.size)}</small>
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  const sourceTimeline = message.timeline ?? [];
  const timeline = sourceTimeline.some((item) => item.kind === "response") || !message.text
    ? sourceTimeline
    : [...sourceTimeline, { id: `${message.id}-response`, kind: "response" as const, text: message.text }];
  const projectedTimeline = projectTimeline(timeline);
  const timelineSections = sectionTimeline(projectedTimeline);
  const lastResponseId = [...timeline].reverse().find((item) => item.kind === "response")?.id;

  return (
    <article className={`assistant-turn ${message.state ?? "complete"}`}>
      {timelineSections.map((section, sectionIndex) => {
        if (section.kind === "response") {
          const item = section.item;
          return (
            <div className="assistant-response" key={item.id}>
              <div className="response-copy"><MarkdownContent>{item.text}</MarkdownContent></div>
              {item.id === lastResponseId && (
                <div className="assistant-message-actions">
                  <MessageCopyButton text={message.text || item.text} subject="response" />
                </div>
              )}
            </div>
          );
        }
        const items = section.items.filter((item) => {
          if (item.kind === "thought") {
            return Boolean(item.text.trim()) || (message.state === "streaming" && item.open);
          }
          return item.kind !== "permission" || item.decision !== undefined;
        });
        if (items.length === 0) return null;
        const isBetweenResponses = timelineSections[sectionIndex - 1]?.kind === "response"
          && timelineSections[sectionIndex + 1]?.kind === "response";
        if (isBetweenResponses) {
          return (
            <CollapsedTraceBlock
              key={section.id}
              items={items}
              messageState={message.state}
            />
          );
        }
        return (
          <div className="turn-trace" role="group" aria-label="Execution trace" key={section.id}>
            <TraceItems items={items} messageState={message.state} />
          </div>
        );
      })}

      <TurnStatusBlock message={message} />
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

function PermissionCard({
  permission,
  busy,
  onRespond,
}: {
  permission: PermissionRequest;
  busy: boolean;
  onRespond: (optionId: string | null) => void;
}) {
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
              disabled={busy}
              key={option.optionId}
              onClick={() => onRespond(option.optionId)}
            >
              {busy ? "Responding…" : option.name}
            </button>
          ))}
          {!hasRejectOption && (
            <button className="reject" type="button" disabled={busy} onClick={() => onRespond(null)}>Cancel request</button>
          )}
        </div>
      </div>
    </aside>
  );
}

export default App;
