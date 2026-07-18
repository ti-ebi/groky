import type { AppUpdateInfo, AppUpdateProgress } from "../host/types";
import { Icon } from "../ui/Icon";
import type { AppUpdatePhase } from "./types";

export function SidebarUpdateCard({
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

