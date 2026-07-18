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
  type SetStateAction,
} from "react";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "@fontsource-variable/sora/index.css";
import "./App.css";
import "./styles/onboarding.css";
import "./styles/workspace.css";
import { GlobalSearchDialog } from "./GlobalSearchDialog";
import { TerminalPanel } from "./TerminalPanel";
import { Onboarding } from "./onboarding/Onboarding";
import {
  SettingsScreen,
  SettingsSidebar,
  type SettingsSection,
} from "./settings/Settings";
import { ConversationItem, PermissionCard } from "./session/Conversation";
import { MessageHistoryNav, conversationTurnPreviews } from "./session/MessageHistoryNav";
import { SessionComposer } from "./session/SessionComposer";
import { enablesAlwaysApprove } from "./session/approval";
import {
  currentModel,
  selectModelInState,
  selectReasoningInState,
} from "./session/models";
import {
  addFallbackThought,
  applySessionUpdateToMessage,
  finishRun,
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
  FileAttachment,
  PermissionRequest,
  SessionModelState,
  SessionReplayProjection,
  SessionUpdate,
  SessionViewState,
} from "./session/types";
import { host } from "./host";
import type {
  AccountProfile,
  AppUpdateInfo,
  AppUpdateProgress,
  OnboardingStage,
  OnboardingStatus,
  PersistedSessionSummary,
  PersistedWorkspaceSummary,
  SessionHistoryAction,
} from "./host/types";
import {
  MAX_SIDEBAR_WIDTH,
  MAX_SIDE_PANEL_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MIN_SIDE_PANEL_WIDTH,
  usePanelLayout,
} from "./layout/usePanelLayout";
import { cleanVersion } from "./shared/format";
import { workspaceName } from "./shared/path";
import { isDesktopHost, isMacOS, usesOverlayTitlebar } from "./shared/platform";
import { AppSidebar } from "./sidebar/AppSidebar";
import {
  compareSidebarSessions,
  groupSidebarSessions,
  type SidebarWorkspaceGroup,
} from "./sidebar/sessionList";
import type { SidebarMenu, SidebarSessionSummary } from "./sidebar/types";
import type { AppUpdatePhase } from "./update/types";
import { DurationText } from "./ui/DurationText";
import { Icon } from "./ui/Icon";

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

interface DeleteConfirmation {
  sessionId?: string;
  workspace?: string;
  title: string;
  description: string;
}

type AppView = "session" | "settings";

const AUTH_REQUIRED_ERROR = "GROK_AUTH_REQUIRED";
const MAX_MESSAGE_ATTACHMENTS = 10;

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
  const {
    sidebarWidth,
    sidebarCollapsed,
    sidePanelWidth,
    sidePanelOpen,
    sidePanelMounted,
    toggleSidebar,
    toggleSidePanel,
    resetSidebarWidth,
    resetSidePanelWidth,
    startSidebarResize,
    resizeSidebar,
    finishSidebarResize,
    resizeSidebarWithKeyboard,
    startSidePanelResize,
    resizeSidePanel,
    finishSidePanelResize,
    resizeSidePanelWithKeyboard,
  } = usePanelLayout({ onSidebarToggle: () => setShowConnection(false) });
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
    if (isDesktopHost()) {
      void host.grok.sessions.activate(sessionId).catch(() => undefined);
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
  const sessionCountByWorkspace = new Map<string, number>();
  sessionHistory.forEach((session) => {
    if (!session.workspace) return;
    sessionCountByWorkspace.set(
      session.workspace,
      (sessionCountByWorkspace.get(session.workspace) ?? 0) + 1,
    );
  });
  const sidebarActionsDisabled = appUpdating || stage === "connecting" || historyMutating || renamingSessionId !== null;
  const sessionLocationEditable = !activeSessionLoading && connection === null && messages.length === 0 && !running;
  const attachmentDisabled = activeSessionLoading || running || appUpdating || stage === "connecting";

  const addAttachmentPaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0 || attachmentDisabled) return;
    const targetSessionId = activeSessionIdRef.current;
    setAttachmentBusy(true);
    try {
      const inspected = await host.attachments.inspect([
        ...attachments.map((attachment) => attachment.path),
        ...paths,
      ]);
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
      const selected = await host.attachments.choose();
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
    if (!isDesktopHost()) return;

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
      void host.configureNativeTitlebar()
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

  async function refreshSessionHistory() {
    if (!isDesktopHost()) return;
    try {
      const [sessions, workspaces] = await Promise.all([
        host.grok.sessions.list(),
        host.grok.workspaces.list(),
      ]);
      setSessionHistory(sessions);
      setWorkspaceHistory(workspaces);
    } catch (error) {
      setConnectionNotice(String(error));
    }
  }

  async function refreshStatus() {
    setSetupError(null);
    if (!isDesktopHost()) {
      setStage("webOnly");
      return;
    }

    setStage("checking");
    try {
      const next = await host.grok.status();
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
    if (!isDesktopHost()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void getVersion().then((version) => {
      if (!disposed) setAppVersion(version);
    }).catch(() => undefined);

    const runAutomaticUpdateCheck = () => {
      if (disposed || updateCheckInFlight.current || updateInstallationInFlight.current) return;
      updateCheckInFlight.current = true;
      setUpdatePhase("checking");
      void host.updates.check()
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

    void host.updates.onProgress((payload) => {
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
    if (!isDesktopHost()) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    void Promise.all([
      host.grok.events.onSessionUpdate((payload) => {
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
      host.grok.events.onPermissionRequest((payload) => {
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
      host.grok.events.onConnection((payload) => {
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
      host.grok.events.onDeviceAuthCode((payload) => {
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
      await host.grok.openInstallGuide();
    } catch (error) {
      setSetupError(String(error));
    }
  }

  async function openUsageDetails() {
    setShowConnection(false);
    try {
      await host.grok.openUsage();
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
      const next = await host.updates.check();
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
      await host.updates.install();
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
      await host.grok.login();
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
      return await host.grok.workspaces.choose();
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
      const next = await host.grok.connect({
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
      const loaded = await host.grok.sessions.load(session.sessionId);
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
      void host.grok.sessions.activate(activeSessionIdRef.current).catch(() => undefined);
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
        void host.grok.sessions.activate(activeSessionIdRef.current).catch(() => undefined);
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
      const added = await host.grok.workspaces.add(selected);
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
      const workspaces = await host.grok.workspaces.remove(path);
      if (disconnectsActiveSession) {
        await host.grok.sessions.deactivate(connection.sessionId).catch(() => undefined);
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
      const sessions = await host.grok.sessions.mutate({
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
      const renamed = await host.grok.sessions.rename(sessionId, normalizedTitle);
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
    activateSession(null);
    setPendingDraft("");
    setPendingAttachments([]);
    if (connection) {
      void host.grok.sessions.deactivate(connection.sessionId).catch(() => undefined);
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
      const switched = await host.grok.sessions.setApprovalMode(sessionId, nextMode);
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
      const loaded = await host.grok.sessions.load(sessionId);
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
      const models = await host.grok.listModels({
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
      const models = await host.grok.sessions.setModel(sessionId, modelId);
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
      const models = await host.grok.sessions.setReasoningEffort(sessionId, reasoningEffort);
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
      const result = await host.grok.prompt({
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
    if (!isDesktopHost() || activeSessionIdRef.current) return;
    const key = workspace ?? "__standalone__";
    const hasCachedCatalog = commandCatalogs[key] !== undefined
      || Object.values(sessionViewsRef.current).some((session) => session.connection.workspace === workspace);
    const requestKey = `${approvalMode}:${key}`;
    if (hasCachedCatalog || commandCatalogRequests.current.has(requestKey)) return;

    commandCatalogRequests.current.add(requestKey);
    try {
      const commands = await host.grok.listCommands({
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
      await host.grok.sessions.cancel(sessionId);
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
      await host.grok.sessions.respondToPermission(
        current.sessionId,
        current.requestId,
        optionId,
      );
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
      await host.grok.logout();
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
      <AppSidebar
        overlayTitlebar={overlayTitlebar}
        sidebarShortcutLabel={sidebarShortcutLabel}
        searchShortcutLabel={searchShortcutLabel}
        searchOpen={globalSearchOpen}
        actionsDisabled={sidebarActionsDisabled}
        workspaceGroups={workspaceGroups}
        standaloneSessions={groupedSidebarSessions.ungrouped}
        collapsedWorkspaces={collapsedWorkspaces}
        sessionCountByWorkspace={sessionCountByWorkspace}
        menu={sidebarMenu}
        activeSessionId={activeSessionId}
        editingSessionId={editingSessionId}
        renamingSessionId={renamingSessionId}
        update={appUpdate}
        updatePhase={updatePhase}
        updateProgress={updateProgress}
        updateError={updateError}
        updateNotice={updateCheckNotice}
        taskRunning={anySessionRunning}
        accountProfile={accountProfile}
        accountName={accountName}
        accountDetail={accountDetail}
        appVersion={appVersion}
        engineVersion={connection?.cliVersion ?? status?.cliVersion ?? "Grok Build"}
        connected={connection !== null}
        connectionOpen={showConnection}
        actions={{
          onToggle: toggleSidebar,
          onOpenSearch: openGlobalSearch,
          onNewSession: (targetWorkspace) => void startNewTask(targetWorkspace),
          onAddWorkspace: () => void chooseAndAddWorkspace(),
          onToggleWorkspace: toggleWorkspaceGroup,
          onMenuChange: setSidebarMenu,
          onArchiveWorkspace: (path) => void mutateSessionHistory("archive", { workspace: path }),
          onDeleteWorkspace: requestWorkspaceDelete,
          onRemoveWorkspace: (path) => void removeWorkspace(path),
          onSelectSession: (session) => void loadSession(session),
          onStartRename: startSessionRename,
          onRename: (sessionId, title) => void renameSession(sessionId, title),
          onCancelRename: () => setEditingSessionId(null),
          onArchiveSession: (sessionId) => void mutateSessionHistory("archive", { sessionId }),
          onRestoreSession: (sessionId) => void mutateSessionHistory("restore", { sessionId }),
          onDeleteSession: requestSessionDelete,
          onInstallUpdate: () => void installAppUpdate(),
          onToggleConnection: () => setShowConnection((current) => !current),
          onOpenUsage: () => void openUsageDetails(),
          onOpenSettings: () => {
            setShowConnection(false);
            setSidebarMenu(null);
            setActiveSettingsSection("application");
            setActiveView("settings");
          },
          onCheckForUpdates: () => void checkForAppUpdate(true),
          onSignOut: () => void signOut(),
        }}
      />
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
          onDoubleClick={resetSidebarWidth}
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

        <SessionComposer
          dockRef={composerDock}
          textareaRef={composerTextarea}
          showScrollToLatest={showScrollToLatest}
          onScrollToLatest={scrollToLatest}
          location={sessionLocationEditable ? {
            value: workspace,
            workspaces: workspaceGroups.map((group) => group.path),
            disabled: sidebarActionsDisabled,
            onChange: selectPendingSessionLocation,
            onAddWorkspace: chooseAndAddWorkspace,
          } : null}
          running={running}
          appUpdating={appUpdating}
          sessionTransitioning={sessionTransitioning}
          plan={plan}
          attachments={attachments}
          attachmentBusy={attachmentBusy}
          attachmentDisabled={attachmentDisabled}
          onChooseAttachments={() => void chooseAttachmentFiles()}
          onRemoveAttachment={(path) => {
            setAttachments(attachments.filter((attachment) => attachment.path !== path));
          }}
          commands={{
            id: commandSuggestionsId,
            suggestions: commandSuggestions,
            activeIndex: activeCommandSuggestion,
            listRef: commandSuggestionsList,
            onActiveIndexChange: setActiveCommandSuggestion,
            onSelect: selectAvailableCommand,
          }}
          draft={draft}
          onDraftChange={handleComposerChange}
          onPromptKeyDown={handleComposerKeyDown}
          approvalMode={approvalMode}
          approvalModeChanging={activeApprovalModeChanging}
          onApprovalModeChange={(nextMode) => void changeApprovalMode(nextMode)}
          model={{
            connected: connection !== null,
            models: connection?.models ?? pendingModels,
            busy: running || appUpdating || sessionTransitioning || activeApprovalModeChanging,
            onLoad: loadModels,
            onChange: changeModel,
            onReasoningChange: changeReasoningEffort,
          }}
          onCancel={() => void cancelRun()}
          onSubmit={submitTask}
        />
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
            onDoubleClick={resetSidePanelWidth}
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
