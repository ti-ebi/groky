import type {
  FormEventHandler,
  KeyboardEventHandler,
  RefObject,
} from "react";
import { formatFileSize } from "../shared/format";
import { SessionLocationSelector } from "../sidebar/SessionLocationSelector";
import { isMacOS } from "../shared/platform";
import { Icon } from "../ui/Icon";
import { PlanBlock } from "./Conversation";
import { FollowUpQueue } from "./FollowUpQueue";
import { ApprovalModeSelector, ModelSelector } from "./SessionControls";
import type {
  ApprovalMode,
  AvailableCommand,
  FileAttachment,
  FollowUpBehavior,
  PlanEntry,
  QueuedPrompt,
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
  pending: boolean;
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
  steering: boolean;
  followUpBehavior: FollowUpBehavior;
  appUpdating: boolean;
  sessionTransitioning: boolean;
  queuedPrompts: QueuedPrompt[];
  queuePaused: boolean;
  pendingSettingLabels: string[];
  settingsApplying: boolean;
  onEditQueuedPrompt: (promptId: string, text: string) => void;
  onMoveQueuedPrompt: (promptId: string, direction: -1 | 1) => void;
  onRemoveQueuedPrompt: (promptId: string) => void;
  onSteerQueuedPrompt: (promptId: string) => void;
  onRunQueuedPromptNow: (promptId: string) => void;
  onResumeQueue: () => void;
  onClearQueue: () => void;
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
  steering,
  followUpBehavior,
  appUpdating,
  sessionTransitioning,
  queuedPrompts,
  queuePaused,
  pendingSettingLabels,
  settingsApplying,
  onEditQueuedPrompt,
  onMoveQueuedPrompt,
  onRemoveQueuedPrompt,
  onSteerQueuedPrompt,
  onRunQueuedPromptNow,
  onResumeQueue,
  onClearQueue,
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
  const promptDisabled = appUpdating || sessionTransitioning;
  const controlsBusy = promptDisabled || approvalModeChanging || settingsApplying;
  const sendDisabled = (!draft.trim() && attachments.length === 0) || controlsBusy || steering;
  const alternateFollowUpShortcut = isMacOS() ? "⌘↵" : "Ctrl+Enter";
  const placeholder = appUpdating
    ? "Groky is installing an update…"
    : running
      ? followUpBehavior === "steer"
        ? "Add direction to the current turn"
        : "Queue a follow-up while Grok works"
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

      <FollowUpQueue
        items={queuedPrompts}
        paused={queuePaused}
        running={running && !settingsApplying && !sessionTransitioning && !appUpdating}
        busy={steering || settingsApplying || sessionTransitioning || appUpdating}
        onEdit={onEditQueuedPrompt}
        onMove={onMoveQueuedPrompt}
        onRemove={onRemoveQueuedPrompt}
        onSteer={onSteerQueuedPrompt}
        onRunNow={onRunQueuedPromptNow}
        onResume={onResumeQueue}
        onClear={onClearQueue}
      />

      <form
        className={`composer approval-mode-${approvalMode} ${running ? "is-running" : ""}`}
        onSubmit={onSubmit}
      >
        {plan.length > 0 && <PlanBlock entries={plan} active={running} />}

        {(pendingSettingLabels.length > 0 || settingsApplying) && (
          <div className={`pending-settings-strip ${settingsApplying ? "is-applying" : ""}`} role="status">
            <span>{settingsApplying ? "APPLYING" : "NEXT TURN"}</span>
            <p>{pendingSettingLabels.join(" · ") || "Updating session settings"}</p>
          </div>
        )}

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
            busy={promptDisabled || settingsApplying}
            changing={approvalModeChanging}
            pending={pendingSettingLabels.some((label) => label.startsWith("Approval:"))}
            onChange={onApprovalModeChange}
          />
          <span className="toolbar-spacer" />
          {running && (
            <span
              className="follow-up-mode-hint"
              title="Cmd/Ctrl+Enter uses the other follow-up behavior"
              role="status"
              aria-live="polite"
              aria-label={steering
                ? "Sending direction"
                : `Follow-up mode: ${followUpBehavior}`}
            >
              {steering ? "SENDING" : followUpBehavior === "queue" ? "QUEUE" : "STEER"}
              <small>{alternateFollowUpShortcut} {followUpBehavior === "queue" ? "steer" : "queue"}</small>
            </span>
          )}
          <ModelSelector {...model} />
          {running && (
            <button className="send-button stop-button" type="button" aria-label="Stop" onClick={onCancel}>
              <Icon name="stop" size={15} />
            </button>
          )}
          <button
            className={`send-button ${running ? "follow-up-send-button" : ""}`}
            type="submit"
            aria-label={running
              ? followUpBehavior === "steer" ? "Steer current turn" : "Queue follow-up"
              : "Send"}
            title={running
              ? followUpBehavior === "steer" ? "Steer current turn" : "Queue for next turn"
              : "Send"}
            disabled={sendDisabled}
          >
            <Icon name={running && followUpBehavior === "queue" ? "arrow-down" : "arrow-up"} size={17} />
          </button>
        </div>
      </form>
    </div>
  );
}
