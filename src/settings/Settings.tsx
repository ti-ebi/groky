import { useMemo, useState } from "react";
import type { AppearancePreference } from "../appearance";
import type { AppUpdateInfo } from "../host/types";
import type { FollowUpBehavior, SessionConfigOption, SessionUsage } from "../session/types";
import { formatTokenCount } from "../shared/format";
import { workspaceName } from "../shared/path";
import type { SidebarSessionSummary } from "../sidebar/types";
import type { AppUpdatePhase } from "../update/types";
import { Icon } from "../ui/Icon";

export type SettingsSection = "application" | "appearance" | "grok" | "account" | "archived";
type ArchivedSessionSort = "updated-desc" | "updated-asc" | "title-asc" | "workspace-asc";

const SETTINGS_SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  description: string;
}> = [
  { id: "application", label: "Application", description: "Version and signed desktop updates" },
  { id: "appearance", label: "Appearance", description: "Choose how Groky looks on this device" },
  { id: "grok", label: "Grok Build", description: "CLI and active session details" },
  { id: "account", label: "Account", description: "Authentication and sign out" },
  { id: "archived", label: "Archived chats", description: "Restore or delete archived chats" },
];

const APPEARANCE_OPTIONS: Array<{
  id: AppearancePreference;
  label: string;
  description: string;
  icon: "monitor" | "sun" | "moon";
}> = [
  { id: "system", label: "System", description: "Follow your device appearance", icon: "monitor" },
  { id: "light", label: "Light", description: "Use the light appearance", icon: "sun" },
  { id: "dark", label: "Dark", description: "Use the dark appearance", icon: "moon" },
];

const FOLLOW_UP_BEHAVIORS = ["queue", "steer"] as const;

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

export function SettingsSidebar({
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

export function SettingsScreen({
  overlayTitlebar,
  section,
  appearance,
  followUpBehavior,
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
  onAppearanceChange,
  onFollowUpBehaviorChange,
  onInstallUpdate,
  onSignOut,
  onRestoreArchived,
  onDeleteArchived,
  onDeleteAllArchived,
}: {
  overlayTitlebar: boolean;
  section: SettingsSection;
  appearance: AppearancePreference;
  followUpBehavior: FollowUpBehavior;
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
  onAppearanceChange: (appearance: AppearancePreference) => void;
  onFollowUpBehaviorChange: (behavior: FollowUpBehavior) => void;
  onInstallUpdate: () => void;
  onSignOut: () => void;
  onRestoreArchived: (sessionId: string) => void;
  onDeleteArchived: (session: SidebarSessionSummary) => void;
  onDeleteAllArchived: () => void;
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
              <div className="settings-row">
                <div>
                  <strong>Messages sent while Grok works</strong>
                  <small>Choose whether Enter queues a new turn or steers the current one. Cmd/Ctrl+Enter temporarily uses the other behavior.</small>
                </div>
                <div className="settings-segmented-control" role="radiogroup" aria-label="Follow-up behavior">
                  {FOLLOW_UP_BEHAVIORS.map((behavior) => (
                    <button
                      className={followUpBehavior === behavior ? "selected" : ""}
                      type="button"
                      role="radio"
                      aria-checked={followUpBehavior === behavior}
                      key={behavior}
                      onClick={() => onFollowUpBehaviorChange(behavior)}
                    >
                      {behavior === "queue" ? "Queue" : "Steer"}
                    </button>
                  ))}
                </div>
              </div>
              {updateNotice && <p className="settings-inline-notice" role="status">{updateNotice}</p>}
            </div>
          </section>}

          {section === "appearance" && <section className="settings-card appearance-settings-card" aria-labelledby="appearance-settings-title">
            <header>
              <div>
                <h2 id="appearance-settings-title">Theme</h2>
                <p>Choose a theme or keep Groky in sync with your device.</p>
              </div>
            </header>
            <fieldset className="appearance-options">
              <legend>Application theme</legend>
              <div className="appearance-option-grid">
                {APPEARANCE_OPTIONS.map((option) => (
                  <label
                    className={`appearance-option ${appearance === option.id ? "selected" : ""}`}
                    key={option.id}
                  >
                    <input
                      type="radio"
                      name="appearance"
                      value={option.id}
                      checked={appearance === option.id}
                      onChange={() => onAppearanceChange(option.id)}
                    />
                    <span className="appearance-preview" data-appearance={option.id} aria-hidden="true">
                      <span className="appearance-preview-sidebar" />
                      <span className="appearance-preview-content">
                        <i />
                        <i />
                        <i />
                      </span>
                    </span>
                    <span className="appearance-option-label">
                      <span><Icon name={option.icon} size={14} /><strong>{option.label}</strong></span>
                      <small>{option.description}</small>
                    </span>
                    <span className="appearance-option-check" aria-hidden="true"><Icon name="check" size={11} /></span>
                  </label>
                ))}
              </div>
            </fieldset>
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
              {archivedSessions.length > 0 && (
                <button
                  className="archived-delete-all"
                  type="button"
                  aria-label={`Delete all ${archivedSessions.length} archived ${archivedSessions.length === 1 ? "chat" : "chats"}`}
                  disabled={archivedActionsDisabled}
                  onClick={onDeleteAllArchived}
                >
                  <Icon name="trash" size={13} />
                  Delete all
                </button>
              )}
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
