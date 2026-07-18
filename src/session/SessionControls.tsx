import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { APPROVAL_MODES, approvalModeOption } from "./approval";
import { currentModel } from "./models";
import type { ApprovalMode, ReasoningEffortInfo, SessionModelState } from "./types";
import { Icon } from "../ui/Icon";

export function ApprovalModeSelector({
  mode,
  busy,
  changing,
  pending,
  onChange,
}: {
  mode: ApprovalMode;
  busy: boolean;
  changing: boolean;
  pending: boolean;
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
        aria-label={`Approval mode: ${selected.label}${pending ? ", applies next turn" : ""}${changing ? ", updating" : ""}`}
        aria-busy={changing}
        disabled={busy || changing}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="shield-mark" aria-hidden="true">{selected.glyph}</span>
        <span>{selected.label}</span>
        {pending && <span className="control-pending-mark">NEXT</span>}
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
            <small>{pending
              ? "This selection is queued for the next turn."
              : "Changes apply before the next request in this session."}</small>
          </div>
        </div>
      )}
    </div>
  );
}
export function ModelSelector({
  connected,
  models,
  busy,
  pending,
  onLoad,
  onChange,
  onReasoningChange,
}: {
  connected: boolean;
  models: SessionModelState | null;
  busy: boolean;
  pending: boolean;
  onLoad: () => Promise<boolean>;
  onChange: (modelId: string) => Promise<SessionModelState | null>;
  onReasoningChange: (reasoningEffort: string) => Promise<SessionModelState | null>;
}) {
  const [open, setOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<"model" | "reasoning" | null>(null);
  const [loading, setLoading] = useState(false);
  const [changingModelId, setChangingModelId] = useState<string | null>(null);
  const [changingReasoningEffort, setChangingReasoningEffort] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ right: number; bottom: number } | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const selected = currentModel(models);
  const reasoningEffort = selected?.metadata?.reasoningEffort;
  const reasoningEfforts = selected?.metadata?.supportsReasoningEffort === false
    ? []
    : selected?.metadata?.reasoningEfforts ?? [];
  const selectedReasoning = reasoningEfforts.find((effort) =>
    effort.id === reasoningEffort || effort.value === reasoningEffort
  );
  const reasoningLabel = selectedReasoning?.label.replace(/\s+Effort$/i, "") ?? reasoningEffort;
  const changing = changingModelId !== null || changingReasoningEffort !== null;

  const updateMenuPosition = useCallback(() => {
    const bounds = root.current?.getBoundingClientRect();
    if (!bounds) return;

    setMenuPosition({
      right: Math.max(8, window.innerWidth - bounds.right - 3),
      bottom: Math.max(8, window.innerHeight - bounds.top + 8),
    });
  }, []);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
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

  useLayoutEffect(() => {
    if (!open) return;

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (busy) setOpen(false);
  }, [busy]);

  async function toggleMenu() {
    if (open) {
      setOpen(false);
      return;
    }
    if (!connected && !models) {
      setLoading(true);
      const loaded = await onLoad();
      setLoading(false);
      if (!loaded) return;
    }
    setActiveSection(null);
    updateMenuPosition();
    setOpen(true);
  }

  async function selectModel(modelId: string) {
    if (modelId === models?.currentModelId) {
      setOpen(false);
      return;
    }
    setChangingModelId(modelId);
    const nextModels = await onChange(modelId);
    setChangingModelId(null);
    if (nextModels) setOpen(false);
  }

  async function selectReasoningEffort(effort: ReasoningEffortInfo) {
    if (effort.value === reasoningEffort || effort.id === reasoningEffort) {
      setOpen(false);
      return;
    }
    setChangingReasoningEffort(effort.value);
    const nextModels = await onReasoningChange(effort.value);
    setChangingReasoningEffort(null);
    if (nextModels) setOpen(false);
  }

  return (
    <div className="model-control" ref={root}>
      <button
        className="model-button"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Model: ${selected?.name ?? "Grok Build default"}${reasoningLabel ? `, reasoning: ${reasoningLabel}` : ""}${pending ? ", applies next turn" : ""}`}
        disabled={busy || loading || changing}
        onClick={() => void toggleMenu()}
      >
        <span>{loading ? "Loading models…" : selected?.name ?? "Grok Build"}</span>
        <span className="reasoning">· {reasoningLabel ?? (connected ? "ACP" : "default")}</span>
        {pending && <span className="control-pending-mark">NEXT</span>}
        <Icon name="chevron-down" size={12} />
      </button>

      {open && menuPosition && createPortal(
        <div
          ref={menu}
          className="approval-menu model-menu model-menu-portal"
          role="menu"
          aria-label="Grok Build model and reasoning settings"
          style={{ right: menuPosition.right, bottom: menuPosition.bottom }}
        >
          <div
            className="model-settings-item"
            role="none"
            onPointerLeave={() => setActiveSection((current) => current === "model" ? null : current)}
          >
            <button
              className={`model-settings-row ${activeSection === "model" ? "active" : ""}`}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={activeSection === "model"}
              disabled={!models || changing}
              onPointerEnter={() => setActiveSection("model")}
              onFocus={() => setActiveSection("model")}
              onClick={() => setActiveSection("model")}
            >
              <span>Model</span>
              <span className="model-settings-value">{selected?.name ?? "Grok Build"}</span>
              {models && <span className="model-settings-chevron" aria-hidden="true">›</span>}
            </button>

            {models && activeSection === "model" && (
              <div className="model-submenu" role="menu" aria-label="Session model">
                {models.availableModels.map((model) => {
                  const isSelected = model.modelId === models.currentModelId;
                  return (
                    <button
                      className="model-submenu-option"
                      type="button"
                      role="menuitemradio"
                      aria-checked={isSelected}
                      disabled={changing}
                      key={model.modelId}
                      onClick={() => void selectModel(model.modelId)}
                    >
                      <span>{changingModelId === model.modelId ? "Switching…" : model.name}</span>
                      {isSelected && <Icon name="check" size={14} />}
                    </button>
                  );
                })}
                {selected?.description && <div className="model-submenu-note">{selected.description}</div>}
              </div>
            )}
          </div>
          {reasoningEfforts.length > 0 && (
            <div
              className="model-settings-item"
              role="none"
              onPointerLeave={() => setActiveSection((current) => current === "reasoning" ? null : current)}
            >
              <button
                className={`model-settings-row ${activeSection === "reasoning" ? "active" : ""}`}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={activeSection === "reasoning"}
                disabled={changing}
                onPointerEnter={() => setActiveSection("reasoning")}
                onFocus={() => setActiveSection("reasoning")}
                onClick={() => setActiveSection("reasoning")}
              >
                <span>Reasoning</span>
                <span className="model-settings-value">{reasoningLabel ?? "Default"}</span>
                <span className="model-settings-chevron" aria-hidden="true">›</span>
              </button>

              {activeSection === "reasoning" && (
                <div className="model-submenu" role="menu" aria-label="Reasoning effort">
                  {reasoningEfforts.map((effort) => {
                    const isSelected = effort.id === reasoningEffort || effort.value === reasoningEffort;
                    return (
                      <button
                        className="model-submenu-option"
                        type="button"
                        role="menuitemradio"
                        aria-checked={isSelected}
                        disabled={changing}
                        key={effort.id}
                        onClick={() => void selectReasoningEffort(effort)}
                      >
                        <span>{changingReasoningEffort === effort.value ? "Changing…" : effort.label.replace(/\s+Effort$/i, "")}</span>
                        {isSelected && <Icon name="check" size={14} />}
                      </button>
                    );
                  })}
                  {selectedReasoning?.description && <div className="model-submenu-note">{selectedReasoning.description}</div>}
                </div>
              )}
            </div>
          )}
          {!models && (
            <div className="model-settings-note">This Grok Build session uses its default model.</div>
          )}
        </div>,
        root.current?.closest<HTMLElement>(".app-shell") ?? document.body,
      )}
    </div>
  );
}
