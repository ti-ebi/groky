import { useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "../ui/Icon";
import type { SidebarSessionSummary } from "./types";

const MAX_SESSION_TITLE_CHARS = 72;

export function SidebarSessionRow({
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

