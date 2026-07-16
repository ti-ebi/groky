import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

export interface SearchableSession {
  sessionId: string;
  title: string;
  workspace: string | null;
  running: boolean;
  needsAttention: boolean;
  updatedAt: number;
}

interface GlobalSearchDialogProps {
  open: boolean;
  sessions: SearchableSession[];
  activeSessionId: string | null;
  archivedCount: number;
  actionsDisabled: boolean;
  shortcutLabel: string;
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onAddWorkspace: () => void;
  onOpenSettings: () => void;
  onOpenArchived: () => void;
}

type PaletteIconName = "archive" | "close" | "compose" | "folder" | "search" | "session" | "settings";
type SearchActionId = "add-workspace" | "archived" | "new-session" | "settings";

interface SearchAction {
  id: SearchActionId;
  label: string;
  description: string;
  icon: PaletteIconName;
  disabled?: boolean;
}

type PaletteItem =
  | { key: string; kind: "session"; session: SearchableSession }
  | { key: string; kind: "action"; action: SearchAction };

interface PaletteGroup {
  id: string;
  label: string;
  items: PaletteItem[];
}

function PaletteIcon({ name, size = 17 }: { name: PaletteIconName; size?: number }) {
  const paths: Record<PaletteIconName, ReactNode> = {
    archive: <><path d="M4 7h16" /><path d="M5 7v12h14V7" /><path d="M3 4h18v3H3Z" /><path d="M9 11h6" /></>,
    close: <><path d="m7 7 10 10" /><path d="M17 7 7 17" /></>,
    compose: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L9 17l-4 1 1-4Z" /></>,
    folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    session: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3" /><path d="M13 15h4" /></>,
    settings: <><path d="M4 7h10" /><path d="M18 7h2" /><path d="M4 17h2" /><path d="M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>,
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

function workspaceName(path: string | null) {
  if (!path) return "Standalone";
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function normalizeSearchText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function queryTokens(value: string) {
  return normalizeSearchText(value).split(/\s+/).filter(Boolean);
}

function rankSession(session: SearchableSession, normalizedQuery: string, tokens: string[]) {
  const title = normalizeSearchText(session.title);
  const workspace = normalizeSearchText(workspaceName(session.workspace));
  const path = normalizeSearchText(session.workspace ?? "standalone");
  const searchable = `${title} ${workspace} ${path}`;
  if (!tokens.every((token) => searchable.includes(token))) return null;

  let rank = 5;
  if (title === normalizedQuery) rank = 0;
  else if (title.startsWith(normalizedQuery)) rank = 1;
  else if (tokens.every((token) => title.includes(token))) rank = 2;
  else if (workspace.startsWith(normalizedQuery)) rank = 3;
  else if (tokens.every((token) => `${workspace} ${path}`.includes(token))) rank = 4;

  return rank;
}

function formatRelativeTime(timestamp: number) {
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 45) return "now";

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const [unit, seconds] = units.find(([, unitSeconds]) => elapsedSeconds >= unitSeconds) ?? ["minute", 60];
  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-Math.round(elapsedSeconds / seconds), unit);
}

function sessionAriaLabel(session: SearchableSession, active: boolean) {
  const status = session.needsAttention
    ? "needs approval"
    : session.running
      ? "running"
      : active
        ? "currently open"
        : "available";
  return `${session.title}, ${workspaceName(session.workspace)}, ${formatRelativeTime(session.updatedAt)}, ${status}`;
}

export function GlobalSearchDialog({
  open,
  sessions,
  activeSessionId,
  archivedCount,
  actionsDisabled,
  shortcutLabel,
  onClose,
  onSelectSession,
  onNewSession,
  onAddWorkspace,
  onOpenSettings,
  onOpenArchived,
}: GlobalSearchDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = useId();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const actions = useMemo<SearchAction[]>(() => [
    {
      id: "new-session",
      label: "New session",
      description: "Start in the current working directory",
      icon: "compose",
      disabled: actionsDisabled,
    },
    {
      id: "add-workspace",
      label: "Add working directory",
      description: "Choose another local project",
      icon: "folder",
      disabled: actionsDisabled,
    },
    {
      id: "settings",
      label: "Open settings",
      description: "Application, Grok Build, and account settings",
      icon: "settings",
    },
    {
      id: "archived",
      label: "View archived chats",
      description: archivedCount === 1 ? "1 archived chat" : `${archivedCount} archived chats`,
      icon: "archive",
    },
  ], [actionsDisabled, archivedCount]);

  const { groups, resultLimitReached } = useMemo(() => {
    const sortedSessions = [...sessions].sort((left, right) => right.updatedAt - left.updatedAt);
    const normalizedQuery = normalizeSearchText(query.trim());
    const tokens = queryTokens(query);
    const availableActions = actions.filter((action) => !action.disabled);
    const nextGroups: PaletteGroup[] = [];
    let limitReached = false;

    if (!normalizedQuery) {
      const attention = sortedSessions.filter((session) => session.needsAttention).slice(0, 4);
      const recent = sortedSessions.filter((session) => !session.needsAttention).slice(0, 8);
      if (attention.length > 0) {
        nextGroups.push({
          id: "attention",
          label: "Needs attention",
          items: attention.map((session) => ({
            key: `session:${session.sessionId}`,
            kind: "session" as const,
            session,
          })),
        });
      }
      if (recent.length > 0) {
        nextGroups.push({
          id: "recent",
          label: "Recent sessions",
          items: recent.map((session) => ({
            key: `session:${session.sessionId}`,
            kind: "session" as const,
            session,
          })),
        });
      }
      if (availableActions.length > 0) {
        nextGroups.push({
          id: "actions",
          label: "Actions",
          items: availableActions.map((action) => ({
            key: `action:${action.id}`,
            kind: "action" as const,
            action,
          })),
        });
      }
      return { groups: nextGroups, resultLimitReached: false };
    }

    const matches = sortedSessions
      .map((session) => ({ session, rank: rankSession(session, normalizedQuery, tokens) }))
      .filter((result): result is { session: SearchableSession; rank: number } => result.rank !== null)
      .sort((left, right) => left.rank - right.rank || right.session.updatedAt - left.session.updatedAt);
    limitReached = matches.length > 40;
    const visibleMatches = matches.slice(0, 40);
    if (visibleMatches.length > 0) {
      nextGroups.push({
        id: "sessions",
        label: "Sessions",
        items: visibleMatches.map(({ session }) => ({
          key: `session:${session.sessionId}`,
          kind: "session" as const,
          session,
        })),
      });
    }

    const matchingActions = availableActions.filter((action) => {
      const searchable = normalizeSearchText(`${action.label} ${action.description}`);
      return tokens.every((token) => searchable.includes(token));
    });
    if (matchingActions.length > 0) {
      nextGroups.push({
        id: "actions",
        label: "Actions",
        items: matchingActions.map((action) => ({
          key: `action:${action.id}`,
          kind: "action" as const,
          action,
        })),
      });
    }

    return { groups: nextGroups, resultLimitReached: limitReached };
  }, [actions, query, sessions]);

  const items = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const activeOptionId = items.length > 0 ? `${listboxId}-option-${Math.min(activeIndex, items.length - 1)}` : undefined;

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActiveIndex(0);
    const animationFrame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(animationFrame);
      previouslyFocused?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open || !activeOptionId) return;
    const animationFrame = window.requestAnimationFrame(() => {
      document.getElementById(activeOptionId)?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [activeOptionId, open]);

  if (!open) return null;

  function choose(item: PaletteItem) {
    const activate = () => {
      if (item.kind === "session") {
        onSelectSession(item.session.sessionId);
        return;
      }
      switch (item.action.id) {
        case "new-session":
          onNewSession();
          break;
        case "add-workspace":
          onAddWorkspace();
          break;
        case "settings":
          onOpenSettings();
          break;
        case "archived":
          onOpenArchived();
          break;
      }
    };
    onClose();
    window.requestAnimationFrame(activate);
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (items.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % items.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + items.length) % items.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(items[Math.min(activeIndex, items.length - 1)]);
    }
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>("[data-global-search-focus]") ?? [],
    );
    if (focusable.length === 0) return;
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.shiftKey
      ? currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1
      : currentIndex >= focusable.length - 1 ? 0 : currentIndex + 1;
    event.preventDefault();
    focusable[nextIndex].focus();
  }

  function dismissFromBackdrop(event: PointerEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) onClose();
  }

  let optionIndex = 0;
  return (
    <div className="global-search-backdrop" role="presentation" onPointerDown={dismissFromBackdrop}>
      <div
        ref={dialogRef}
        className="global-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Search sessions and actions"
        onKeyDown={handleDialogKeyDown}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="global-search-input-row">
          <span className="global-search-input-icon"><PaletteIcon name="search" size={20} /></span>
          <input
            ref={inputRef}
            data-global-search-focus
            value={query}
            role="combobox"
            aria-label="Search sessions or run an action"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={activeOptionId}
            autoComplete="off"
            spellCheck="false"
            placeholder="Search sessions or run an action"
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleInputKeyDown}
          />
          <button
            className="global-search-close"
            type="button"
            data-global-search-focus
            aria-label="Close search"
            title={`Close search (${shortcutLabel})`}
            onClick={onClose}
          >
            <PaletteIcon name="close" size={18} />
          </button>
        </div>

        <div className="global-search-results" id={listboxId} role="listbox" aria-label="Search results">
          {groups.length === 0 ? (
            <div className="global-search-empty" role="status">
              <span className="global-search-empty-icon"><PaletteIcon name="search" size={20} /></span>
              <strong>No matching sessions or actions</strong>
              <span>Try a session title or working directory.</span>
            </div>
          ) : (
            groups.map((group) => {
              const groupLabelId = `${listboxId}-${group.id}-label`;
              return (
                <section className="global-search-group" role="group" aria-labelledby={groupLabelId} key={group.id}>
                  <div className="global-search-group-heading" id={groupLabelId}>{group.label}</div>
                  {group.items.map((item) => {
                    const currentIndex = optionIndex++;
                    const selected = currentIndex === Math.min(activeIndex, items.length - 1);
                    const optionId = `${listboxId}-option-${currentIndex}`;
                    if (item.kind === "session") {
                      const session = item.session;
                      const isActive = session.sessionId === activeSessionId;
                      return (
                        <button
                          className="global-search-option session-option"
                          type="button"
                          role="option"
                          id={optionId}
                          key={item.key}
                          tabIndex={-1}
                          aria-label={sessionAriaLabel(session, isActive)}
                          aria-selected={selected}
                          title={session.workspace ?? "Standalone session"}
                          onPointerMove={() => setActiveIndex(currentIndex)}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => choose(item)}
                        >
                          <span className={`global-search-session-state ${session.needsAttention ? "attention" : session.running ? "running" : "idle"}`} aria-hidden="true">
                            {session.needsAttention ? "!" : session.running ? <span /> : <PaletteIcon name="session" size={15} />}
                          </span>
                          <span className="global-search-option-copy">
                            <strong>{session.title}</strong>
                            <small>{workspaceName(session.workspace)}</small>
                          </span>
                          <span className="global-search-option-meta">
                            <time dateTime={new Date(session.updatedAt).toISOString()}>{formatRelativeTime(session.updatedAt)}</time>
                            {isActive && <span>Open</span>}
                          </span>
                        </button>
                      );
                    }

                    return (
                      <button
                        className="global-search-option action-option"
                        type="button"
                        role="option"
                        id={optionId}
                        key={item.key}
                        tabIndex={-1}
                        aria-selected={selected}
                        onPointerMove={() => setActiveIndex(currentIndex)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => choose(item)}
                      >
                        <span className="global-search-action-icon" aria-hidden="true"><PaletteIcon name={item.action.icon} size={16} /></span>
                        <span className="global-search-option-copy">
                          <strong>{item.action.label}</strong>
                          <small>{item.action.description}</small>
                        </span>
                      </button>
                    );
                  })}
                </section>
              );
            })
          )}
          {sessions.length === 0 && !query && (
            <p className="global-search-first-session">No sessions yet. Use <strong>New session</strong> to create your first one.</p>
          )}
        </div>

        <div className="global-search-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>Enter</kbd> Open</span>
          <span><kbd>Esc</kbd> Close</span>
          {resultLimitReached && <span className="global-search-result-limit">Showing the top 40 matches</span>}
        </div>
        <span className="global-search-result-count" aria-live="polite">
          {items.length === 1 ? "1 result" : `${items.length} results`}
        </span>
      </div>
    </div>
  );
}
