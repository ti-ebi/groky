import { useEffect, useState, type KeyboardEvent } from "react";
import { Icon } from "../ui/Icon";
import type { QueuedPrompt } from "./types";

interface FollowUpQueueProps {
  items: QueuedPrompt[];
  paused: boolean;
  running: boolean;
  busy: boolean;
  onEdit: (promptId: string, text: string) => void;
  onMove: (promptId: string, direction: -1 | 1) => void;
  onRemove: (promptId: string) => void;
  onSteer: (promptId: string) => void;
  onRunNow: (promptId: string) => void;
  onResume: () => void;
  onClear: () => void;
}

function queuedPromptSummary(item: QueuedPrompt) {
  if (item.text) return item.text;
  const count = item.attachments.length;
  return `${count} attached ${count === 1 ? "file" : "files"}`;
}

export function FollowUpQueue({
  items,
  paused,
  running,
  busy,
  onEdit,
  onMove,
  onRemove,
  onSteer,
  onRunNow,
  onResume,
  onClear,
}: FollowUpQueueProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");

  useEffect(() => {
    if (editingId && !items.some((item) => item.id === editingId)) {
      setEditingId(null);
      setEditingText("");
    }
  }, [editingId, items]);

  if (items.length === 0) return null;

  function startEditing(item: QueuedPrompt) {
    setEditingId(item.id);
    setEditingText(item.text);
  }

  function saveEditing() {
    const item = items.find((candidate) => candidate.id === editingId);
    if (!item || (!editingText.trim() && item.attachments.length === 0)) return;
    onEdit(item.id, editingText);
    setEditingId(null);
    setEditingText("");
  }

  function handleEditingKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setEditingId(null);
      setEditingText("");
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      saveEditing();
    }
  }

  return (
    <section
      className={`follow-up-queue ${paused ? "is-paused" : ""}`}
      aria-label="Queued follow-up messages"
      aria-busy={busy}
    >
      <header className="follow-up-queue-heading">
        <span className="follow-up-queue-title">
          <i aria-hidden="true" />
          NEXT UP
          <strong>{items.length}</strong>
        </span>
        <span className="follow-up-queue-state">{busy ? "Updating…" : paused ? "Paused" : running ? "After this turn" : "Ready"}</span>
        <span className="follow-up-queue-spacer" />
        {paused && (
          <button className="follow-up-queue-text-action" type="button" disabled={busy} onClick={onResume}>
            Resume
          </button>
        )}
        <button className="follow-up-queue-text-action" type="button" disabled={busy} onClick={onClear}>
          Clear
        </button>
      </header>

      <div className="follow-up-queue-list">
        {items.map((item, index) => {
          const editing = editingId === item.id;
          const canSteer = running && item.text.trim().length > 0 && item.attachments.length === 0;
          return (
            <article className="follow-up-item" key={item.id}>
              <span className="follow-up-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
              {editing ? (
                <textarea
                  aria-label={`Edit queued message ${index + 1}`}
                  value={editingText}
                  rows={2}
                  autoFocus
                  disabled={busy}
                  onChange={(event) => setEditingText(event.target.value)}
                  onKeyDown={handleEditingKeyDown}
                />
              ) : (
                <button
                  className="follow-up-copy"
                  type="button"
                  title="Edit queued message"
                  disabled={busy}
                  onClick={() => startEditing(item)}
                >
                  <span>{queuedPromptSummary(item)}</span>
                  {item.attachments.length > 0 && (
                    <small><Icon name="paperclip" size={11} />{item.attachments.length}</small>
                  )}
                </button>
              )}

              <div className="follow-up-actions">
                {editing ? (
                  <>
                    <button
                      type="button"
                      aria-label="Cancel editing queued message"
                      title="Cancel"
                      onClick={() => {
                        setEditingId(null);
                        setEditingText("");
                      }}
                    >
                      <Icon name="x" size={12} />
                    </button>
                    <button
                      type="button"
                      aria-label="Save queued message"
                      title="Save (Cmd/Ctrl+Enter)"
                      disabled={busy || (!editingText.trim() && item.attachments.length === 0)}
                      onClick={saveEditing}
                    >
                      <Icon name="check" size={12} />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      aria-label="Move queued message up"
                      title="Move up"
                      disabled={busy || index === 0}
                      onClick={() => onMove(item.id, -1)}
                    >
                      <Icon name="arrow-up" size={12} />
                    </button>
                    <button
                      type="button"
                      aria-label="Move queued message down"
                      title="Move down"
                      disabled={busy || index === items.length - 1}
                      onClick={() => onMove(item.id, 1)}
                    >
                      <Icon name="arrow-down" size={12} />
                    </button>
                    <button
                      className="follow-up-run-now"
                      type="button"
                      aria-label="Stop the current turn and run this message"
                      title={running ? "Stop current turn and run this next" : "Run this next"}
                      disabled={busy || !running}
                      onClick={() => onRunNow(item.id)}
                    >
                      <Icon name="stop" size={11} />
                    </button>
                    <button
                      className="follow-up-steer"
                      type="button"
                      aria-label="Steer current turn with this message"
                      title={canSteer ? "Steer current turn" : "Text-only messages can steer a running turn"}
                      disabled={busy || !canSteer}
                      onClick={() => onSteer(item.id)}
                    >
                      <Icon name="arrow-right" size={12} />
                    </button>
                    <button
                      type="button"
                      aria-label="Remove queued message"
                      title="Remove"
                      disabled={busy}
                      onClick={() => onRemove(item.id)}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
