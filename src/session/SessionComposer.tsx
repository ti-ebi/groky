import type {
  FormEventHandler,
  KeyboardEventHandler,
  RefObject,
} from "react";
import { formatFileSize } from "../shared/format";
import { SessionLocationSelector } from "../sidebar/SessionLocationSelector";
import { Icon } from "../ui/Icon";
import { PlanBlock } from "./Conversation";
import { ApprovalModeSelector, ModelSelector } from "./SessionControls";
import type {
  ApprovalMode,
  AvailableCommand,
  FileAttachment,
  PlanEntry,
  SessionModelState,
} from "./types";

interface ComposerLocation {
  value: string | null;
  workspaces: string[];
  disabled: boolean;
  onChange: (workspace: string | null) => void;
  onAddWorkspace: () => Promise<string | null>;
}

interface CommandMenu {
  id: string;
  suggestions: AvailableCommand[];
  activeIndex: number;
  listRef: RefObject<HTMLDivElement | null>;
  onActiveIndexChange: (index: number) => void;
  onSelect: (command: AvailableCommand) => void;
}

interface ModelControl {
  connected: boolean;
  models: SessionModelState | null;
  busy: boolean;
  onLoad: () => Promise<boolean>;
  onChange: (modelId: string) => Promise<SessionModelState | null>;
  onReasoningChange: (reasoningEffort: string) => Promise<SessionModelState | null>;
}

interface SessionComposerProps {
  dockRef: RefObject<HTMLDivElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  showScrollToLatest: boolean;
  onScrollToLatest: () => void;
  location: ComposerLocation | null;
  running: boolean;
  appUpdating: boolean;
  sessionTransitioning: boolean;
  plan: PlanEntry[];
  attachments: FileAttachment[];
  attachmentBusy: boolean;
  attachmentDisabled: boolean;
  onChooseAttachments: () => void;
  onRemoveAttachment: (path: string) => void;
  commands: CommandMenu;
  draft: string;
  onDraftChange: (draft: string) => void;
  onPromptKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  approvalMode: ApprovalMode;
  approvalModeChanging: boolean;
  onApprovalModeChange: (mode: ApprovalMode) => void;
  model: ModelControl;
  onCancel: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
}

export function SessionComposer({
  dockRef,
  textareaRef,
  showScrollToLatest,
  onScrollToLatest,
  location,
  running,
  appUpdating,
  sessionTransitioning,
  plan,
  attachments,
  attachmentBusy,
  attachmentDisabled,
  onChooseAttachments,
  onRemoveAttachment,
  commands,
  draft,
  onDraftChange,
  onPromptKeyDown,
  approvalMode,
  approvalModeChanging,
  onApprovalModeChange,
  model,
  onCancel,
  onSubmit,
}: SessionComposerProps) {
  const promptDisabled = running || appUpdating || sessionTransitioning;
  const controlsBusy = promptDisabled || approvalModeChanging;
  const sendDisabled = (!draft.trim() && attachments.length === 0) || controlsBusy;
  const placeholder = appUpdating
    ? "Groky is installing an update…"
    : running
      ? "Grok is working…"
      : "Ask Groky to build, debug, or review";

  return (
    <div ref={dockRef} className="composer-dock">
      {showScrollToLatest && (
        <button
          className="scroll-to-latest"
          type="button"
          aria-label="Scroll to latest message"
          aria-controls="task-conversation"
          onClick={onScrollToLatest}
        >
          <Icon name="arrow-down" size={14} />
          <span>Latest</span>
        </button>
      )}

      {location && (
        <section className="session-start-config" aria-label="Session location">
          <SessionLocationSelector {...location} />
        </section>
      )}

      <form
        className={`composer approval-mode-${approvalMode} ${running ? "is-running" : ""}`}
        onSubmit={onSubmit}
      >
        {plan.length > 0 && <PlanBlock entries={plan} active={running} />}

        {attachments.length > 0 && (
          <div className="attachment-tray" aria-label="Files attached to this message">
            {attachments.map((attachment) => (
              <div className="attachment-chip" key={attachment.path}>
                <span className="attachment-chip-icon"><Icon name="paperclip" size={13} /></span>
                <span className="attachment-chip-copy">
                  <strong>{attachment.name}</strong>
                  <small>{formatFileSize(attachment.size)}</small>
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  disabled={attachmentDisabled}
                  onClick={() => onRemoveAttachment(attachment.path)}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {commands.suggestions.length > 0 && (
          <div
            ref={commands.listRef}
            className="command-suggestions"
            id={commands.id}
            role="listbox"
            aria-label="Available Grok commands"
          >
            <div className="command-suggestions-heading">
              <span className="command-suggestions-label">COMMANDS</span>
              <small>{commands.suggestions.length} available</small>
            </div>
            {commands.suggestions.map((command, index) => (
              <button
                type="button"
                role="option"
                id={`${commands.id}-option-${index}`}
                key={command.name}
                data-command-index={index}
                aria-selected={index === commands.activeIndex}
                tabIndex={-1}
                onPointerMove={() => commands.onActiveIndexChange(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commands.onSelect(command)}
              >
                <code>/{command.name}</code>
                <span>{command.description}</span>
                {command.inputHint && <small>{command.inputHint}</small>}
              </button>
            ))}
            <div className="command-suggestions-help" aria-hidden="true">
              <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
              <span><kbd>Enter</kbd> choose</span>
              <span><kbd>Esc</kbd> close</span>
            </div>
          </div>
        )}

        <div className="prompt-row">
          <span className="prompt-symbol" aria-hidden="true">❯</span>
          <textarea
            ref={textareaRef}
            aria-label="Session prompt"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={onPromptKeyDown}
            aria-autocomplete="list"
            aria-controls={commands.suggestions.length > 0 ? commands.id : undefined}
            aria-expanded={commands.suggestions.length > 0}
            aria-activedescendant={commands.suggestions.length > 0
              ? `${commands.id}-option-${commands.activeIndex}`
              : undefined}
            placeholder={placeholder}
            rows={2}
            disabled={promptDisabled}
          />
        </div>

        <div className="composer-toolbar">
          <button
            className="icon-button attachment-button add-context"
            type="button"
            aria-label="Attach files"
            title="Attach files"
            aria-busy={attachmentBusy}
            disabled={attachmentDisabled || attachmentBusy}
            onClick={onChooseAttachments}
          >
            <Icon name="paperclip" size={16} />
          </button>
          <ApprovalModeSelector
            mode={approvalMode}
            busy={promptDisabled}
            changing={approvalModeChanging}
            onChange={onApprovalModeChange}
          />
          <span className="toolbar-spacer" />
          <ModelSelector {...model} />
          {running ? (
            <button className="send-button stop-button" type="button" aria-label="Stop" onClick={onCancel}>
              <Icon name="stop" size={15} />
            </button>
          ) : (
            <button className="send-button" type="submit" aria-label="Send" disabled={sendDisabled}>
              <Icon name="arrow-up" size={17} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
