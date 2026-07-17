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
  type SetStateAction,
} from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "@fontsource-variable/sora/index.css";
import "./App.css";
import { ConversationItem } from "./ConversationItem";
import { DurationText } from "./DurationText";
import { cleanVersion, isMacOS, isTauri, usesOverlayTitlebar } from "./environment";
import { formatFileSize } from "./format";
import { Icon } from "./Icon";
import { MessageHistoryNav } from "./MessageHistoryNav";
import { Onboarding } from "./Onboarding";
import { PermissionCard } from "./PermissionCard";
import { PlanBlock } from "./PlanBlock";
import { ApprovalModeSelector } from "./ApprovalModeSelector";
import { ModelSelector } from "./ModelSelector";
import { SettingsScreen } from "./SettingsScreen";
import { SettingsSidebar } from "./SettingsSidebar";
import { SidebarUpdateCard } from "./SidebarUpdateCard";
import type { AppUpdatePhase, SettingsSection } from "./settings";
import { Brand } from "./Brand";
import { SessionLocationSelector } from "./SessionLocationSelector";
import { SidebarSessionRow } from "./SidebarSessionRow";
import {
  compareSidebarSessions,
  groupSidebarSessions,
  workspaceName,
} from "./sidebarSessions";
import { GlobalSearchDialog } from "./GlobalSearchDialog";
import { TerminalPanel } from "./TerminalPanel";
import {
  addFallbackThought,
  applySessionUpdateToMessage,
  conversationTurnPreviews,
  finishRun,
  makeMessageId,
  reconcileFallbackResponse,
  sessionReplayProjection,
  stateFromStopReason,
  terminalToolStatus,
  type SessionReplayProjection,
} from "./sessionProjection";
import {
  currentModel,
  enablesAlwaysApprove,
  selectModelInState,
  selectReasoningInState,
} from "./sessionOptions";
import type {
  AccountProfile,
  AppUpdateInfo,
  AppUpdateProgress,
  ApprovalMode,
  AvailableCommand,
  Connection,
  ConnectionEvent,
  ConversationMessage,
  DeviceAuthCodeEvent,
  FileAttachment,
  LoadSessionResult,
  OnboardingStage,
  OnboardingStatus,
  PermissionRequest,
  PersistedSessionSummary,
  PersistedWorkspaceSummary,
  PromptResult,
  SessionModelState,
  SessionUpdate,
  SessionViewState,
  SidebarSessionSummary,
  SidebarWorkspaceGroup,
} from "./sessionTypes";

const INITIAL_UPDATE_CHECK_DELAY_MS = 1_200;
const AUTOMATIC_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;

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

type AppView = "session" | "settings";

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

export default App;
