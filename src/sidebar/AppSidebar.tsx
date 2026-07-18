import type { AccountProfile, AppUpdateInfo, AppUpdateProgress } from "../host/types";
import { workspaceName } from "../shared/path";
import { SidebarUpdateCard } from "../update/SidebarUpdateCard";
import type { AppUpdatePhase } from "../update/types";
import { Brand } from "../ui/Brand";
import { Icon } from "../ui/Icon";
import { SidebarSessionRow } from "./SidebarSessionRow";
import type { SidebarWorkspaceGroup } from "./sessionList";
import type { SidebarMenu, SidebarSessionSummary } from "./types";

interface SidebarActions {
  onToggle: () => void;
  onOpenSearch: () => void;
  onNewSession: (workspace?: string) => void;
  onAddWorkspace: () => void;
  onToggleWorkspace: (path: string) => void;
  onMenuChange: (menu: SidebarMenu) => void;
  onArchiveWorkspace: (path: string) => void;
  onDeleteWorkspace: (path: string) => void;
  onRemoveWorkspace: (path: string) => void;
  onSelectSession: (session: SidebarSessionSummary) => void;
  onStartRename: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onCancelRename: () => void;
  onArchiveSession: (sessionId: string) => void;
  onRestoreSession: (sessionId: string) => void;
  onDeleteSession: (session: SidebarSessionSummary) => void;
  onInstallUpdate: () => void;
  onToggleConnection: () => void;
  onOpenUsage: () => void;
  onOpenSettings: () => void;
  onCheckForUpdates: () => void;
  onSignOut: () => void;
}

interface AppSidebarProps {
  overlayTitlebar: boolean;
  sidebarShortcutLabel: string;
  searchShortcutLabel: string;
  searchOpen: boolean;
  actionsDisabled: boolean;
  workspaceGroups: SidebarWorkspaceGroup[];
  standaloneSessions: SidebarSessionSummary[];
  collapsedWorkspaces: Set<string>;
  sessionCountByWorkspace: Map<string, number>;
  menu: SidebarMenu;
  activeSessionId: string | null;
  editingSessionId: string | null;
  renamingSessionId: string | null;
  update: AppUpdateInfo | null;
  updatePhase: AppUpdatePhase;
  updateProgress: AppUpdateProgress | null;
  updateError: string | null;
  updateNotice: string | null;
  taskRunning: boolean;
  accountProfile: AccountProfile | null;
  accountName: string;
  accountDetail: string;
  appVersion: string | null;
  engineVersion: string;
  connected: boolean;
  connectionOpen: boolean;
  actions: SidebarActions;
}

function accountAvatarLabel(profile: AccountProfile | null) {
  const label = profile?.displayName ?? profile?.email ?? "G";
  return Array.from(label.trim())[0]?.toLocaleUpperCase() ?? "G";
}

function updateActionLabel(
  update: AppUpdateInfo | null,
  phase: AppUpdatePhase,
  taskRunning: boolean,
) {
  if (!update) return phase === "checking" ? "Checking…" : "Check now";
  if (phase === "downloading") return "Updating…";
  return taskRunning ? "Finish current turn first" : "Update & restart";
}

export function AppSidebar({
  overlayTitlebar,
  sidebarShortcutLabel,
  searchShortcutLabel,
  searchOpen,
  actionsDisabled,
  workspaceGroups,
  standaloneSessions,
  collapsedWorkspaces,
  sessionCountByWorkspace,
  menu,
  activeSessionId,
  editingSessionId,
  renamingSessionId,
  update,
  updatePhase,
  updateProgress,
  updateError,
  updateNotice,
  taskRunning,
  accountProfile,
  accountName,
  accountDetail,
  appVersion,
  engineVersion,
  connected,
  connectionOpen,
  actions,
}: AppSidebarProps) {
  const dragRegionProps = overlayTitlebar ? { "data-tauri-drag-region": "deep" } : {};

  function toggleSessionMenu(sessionId: string) {
    actions.onMenuChange(
      menu?.kind === "session" && menu.sessionId === sessionId
        ? null
        : { kind: "session", sessionId },
    );
  }

  function sessionRow(session: SidebarSessionSummary) {
    return (
      <SidebarSessionRow
        key={session.sessionId}
        session={session}
        selected={activeSessionId === session.sessionId}
        disabled={actionsDisabled}
        editing={editingSessionId === session.sessionId}
        renaming={renamingSessionId === session.sessionId}
        menuOpen={menu?.kind === "session" && menu.sessionId === session.sessionId}
        onSelect={() => actions.onSelectSession(session)}
        onToggleMenu={() => toggleSessionMenu(session.sessionId)}
        onStartRename={() => actions.onStartRename(session.sessionId)}
        onRename={(title) => actions.onRename(session.sessionId, title)}
        onCancelRename={actions.onCancelRename}
        onArchive={() => actions.onArchiveSession(session.sessionId)}
        onRestore={() => actions.onRestoreSession(session.sessionId)}
        onDelete={() => actions.onDeleteSession(session)}
      />
    );
  }

  return (
    <aside className="sidebar">
      <div className="window-nav" {...dragRegionProps}>
        <button
          className="icon-button sidebar-toggle"
          type="button"
          aria-label="Hide sidebar"
          title={`Hide sidebar (${sidebarShortcutLabel})`}
          onClick={actions.onToggle}
        >
          <Icon name="panel" />
        </button>
      </div>

      <div className="brand-row">
        <Brand />
        <button
          className="icon-button brand-search"
          type="button"
          aria-label="Search sessions and actions"
          aria-haspopup="dialog"
          aria-expanded={searchOpen}
          title={`Search sessions and actions (${searchShortcutLabel})`}
          onClick={actions.onOpenSearch}
        >
          <Icon name="search" size={18} />
        </button>
      </div>

      <nav className="primary-nav" aria-label="Primary">
        <button type="button" onClick={() => actions.onNewSession()} disabled={actionsDisabled}>
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
            disabled={actionsDisabled}
            onClick={actions.onAddWorkspace}
          >
            <Icon name="plus" size={15} />
          </button>
        </div>

        {workspaceGroups.map((group) => {
          const expanded = !collapsedWorkspaces.has(group.path);
          const menuOpen = menu?.kind === "workspace" && menu.path === group.path;
          const sessionCount = sessionCountByWorkspace.get(group.path) ?? 0;
          const name = workspaceName(group.path);

          return (
            <section className="project-group" key={group.path}>
              <div
                className={`project-heading-row ${menuOpen ? "actions-visible" : ""}`}
                data-open={expanded}
                data-sidebar-menu-root
              >
                <button
                  className="project-heading"
                  type="button"
                  aria-expanded={expanded}
                  title={group.path}
                  onClick={() => actions.onToggleWorkspace(group.path)}
                >
                  <Icon name={expanded ? "folder-open" : "folder"} />
                  <span>{name}</span>
                </button>
                <div className="project-row-actions">
                  <button
                    className="project-more"
                    type="button"
                    aria-label={`Actions for ${name}`}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    disabled={actionsDisabled}
                    onClick={() => actions.onMenuChange(menuOpen ? null : { kind: "workspace", path: group.path })}
                  >
                    <Icon name="dots" size={15} />
                  </button>
                  <button
                    className="project-new-session"
                    type="button"
                    aria-label={`New session in ${name}`}
                    title={`New session in ${name}`}
                    disabled={actionsDisabled}
                    onClick={() => actions.onNewSession(group.path)}
                  >
                    <Icon name="plus" size={15} />
                  </button>
                </div>
                {menuOpen && (
                  <div className="sidebar-context-menu workspace-context-menu" role="menu" aria-label={`Actions for ${name}`}>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={group.sessions.length === 0}
                      onClick={() => actions.onArchiveWorkspace(group.path)}
                    >
                      <Icon name="archive" size={14} />
                      <span>Archive all sessions</span>
                    </button>
                    <button
                      className="danger-menu-item"
                      type="button"
                      role="menuitem"
                      disabled={sessionCount === 0}
                      onClick={() => actions.onDeleteWorkspace(group.path)}
                    >
                      <Icon name="trash" size={14} />
                      <span>Delete all sessions</span>
                    </button>
                    <button
                      className="remove-workspace-menu-item"
                      type="button"
                      role="menuitem"
                      onClick={() => actions.onRemoveWorkspace(group.path)}
                    >
                      <Icon name="folder-x" size={14} />
                      <span>Remove from Groky</span>
                    </button>
                  </div>
                )}
              </div>
              <div
                className={`project-session-reveal ${expanded ? "is-open" : ""}`}
                aria-hidden={!expanded}
                inert={!expanded}
              >
                <div className="project-session-reveal-inner">
                  {group.sessions.length > 0 ? (
                    <div className="task-list" aria-label={`Sessions in ${name}`}>
                      {group.sessions.map(sessionRow)}
                    </div>
                  ) : (
                    <p className="project-empty-state">No sessions yet</p>
                  )}
                </div>
              </div>
            </section>
          );
        })}

        {standaloneSessions.length > 0 && (
          <section className="unassigned-tasks">
            <p className="section-label">Standalone sessions</p>
            <div className="task-list ungrouped-task-list" aria-label="Standalone sessions">
              {standaloneSessions.map(sessionRow)}
            </div>
          </section>
        )}
      </div>

      {update && (
        <SidebarUpdateCard
          update={update}
          phase={updatePhase}
          progress={updateProgress}
          error={updateError}
          taskRunning={taskRunning}
          onInstall={actions.onInstallUpdate}
        />
      )}

      <button
        className="profile-row"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={connectionOpen}
        data-connection-popover-root
        onClick={actions.onToggleConnection}
      >
        <span className="avatar" aria-hidden="true">{accountAvatarLabel(accountProfile)}</span>
        <span className="profile-copy">
          <strong>{accountName}</strong>
          <small title={accountDetail}>{accountDetail}</small>
        </span>
        {connected && <span className="connection-pill">live</span>}
      </button>

      {connectionOpen && (
        <div
          className="connection-popover"
          role="dialog"
          aria-label="Grok Build statistics and account"
          data-connection-popover-root
        >
          <dl>
            <div><dt>Groky</dt><dd>{appVersion ? `Version ${appVersion}` : "Version unavailable"}</dd></div>
            <div><dt>Engine</dt><dd>{engineVersion}</dd></div>
          </dl>
          <button className="popover-settings-link popover-usage-link" type="button" onClick={actions.onOpenUsage}>
            <Icon name="gauge" size={14} />
            <span>Usage &amp; limits</span>
            <span className="popover-settings-arrow"><Icon name="external-link" size={12} /></span>
          </button>
          <button className="popover-settings-link" type="button" onClick={actions.onOpenSettings}>
            <Icon name="sliders" size={14} />
            <span>Settings</span>
            <span className="popover-settings-arrow"><Icon name="arrow-right" size={12} /></span>
          </button>
          <div className={`popover-update ${update ? "available" : ""}`}>
            <button
              type="button"
              onClick={update ? actions.onInstallUpdate : actions.onCheckForUpdates}
              disabled={updatePhase === "checking" || updatePhase === "downloading" || (update !== null && taskRunning)}
            >
              <Icon name={update ? "download" : "refresh"} size={13} />
              {updateActionLabel(update, updatePhase, taskRunning)}
            </button>
            <small aria-live="polite">
              {update
                ? `Version ${update.version} was found automatically.`
                : updateNotice ?? "Automatic update checks are on."}
            </small>
          </div>
          <div className="popover-actions">
            <button className="danger-action" type="button" onClick={actions.onSignOut}>
              <Icon name="logout" size={14} /> Sign out
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
