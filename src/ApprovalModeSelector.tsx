import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { APPROVAL_MODES, approvalModeOption } from "./sessionOptions";
import type { ApprovalMode } from "./sessionTypes";

export function ApprovalModeSelector({
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
