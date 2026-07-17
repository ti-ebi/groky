import { useEffect, useRef, useState } from "react";
import type { ConversationTurnPreview } from "./sessionTypes";

export function MessageHistoryNav({
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
