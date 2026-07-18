import { useEffect, useId, useRef, useState } from "react";
import { MarkdownContent } from "../MarkdownContent";
import { copyToClipboard } from "../shared/clipboard";
import { formatFileSize, formatTokenCount } from "../shared/format";
import { combineTimings } from "../timing";
import {
  DurationText,
  formatDuration,
  formatThoughtDuration,
} from "../ui/DurationText";
import { Icon } from "../ui/Icon";
import { isActiveToolStatus } from "./projection";
import {
  projectTimeline,
  sectionTimeline,
  toolGroupSummary,
  traceGroupDetails,
  traceItemTiming,
  visibleTraceItems,
  type TraceTimelineItem,
} from "./timeline";
import type {
  ConversationMessage,
  ConversationState,
  PermissionRequest,
  PlanEntry,
  ToolActivity,
  TurnTimelineItem,
} from "./types";

function MessageCopyButton({
  text,
  subject,
}: {
  text: string;
  subject: "request" | "response";
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const resetTimer = useRef<number | null>(null);
  const subjectLabel = subject === "request" ? "Request" : "Response";
  const buttonLabel = copyState === "copied"
    ? `${subjectLabel} copied`
    : copyState === "error"
      ? `Retry copying ${subject}`
      : `Copy ${subject}`;

  useEffect(() => {
    setCopyState("idle");
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);

    return () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    };
  }, [text]);

  async function copyMessage() {
    try {
      await copyToClipboard(text);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }

    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 2_200);
  }

  return (
    <button
      className={`message-copy-button ${copyState}`}
      type="button"
      aria-label={buttonLabel}
      title={buttonLabel}
      onClick={() => void copyMessage()}
    >
      <Icon name={copyState === "copied" ? "check" : "copy"} size={12} />
      <span className="message-copy-status" aria-live="polite">
        {copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : ""}
      </span>
    </button>
  );
}

function ThoughtBlock({
  thought,
  active,
  startedAt,
  endedAt,
  elapsedMs,
}: {
  thought: string;
  active: boolean;
  startedAt?: number;
  endedAt?: number;
  elapsedMs?: number;
}) {
  const [open, setOpen] = useState(active);
  const contentId = useId();

  useEffect(() => {
    setOpen(active);
  }, [active]);

  if (!active && !thought.trim()) return null;

  const label = active
    ? (
        <>
          <span>Thinking</span>
          <DurationText
            timing={{ startedAt, endedAt, elapsedMs }}
            active
            label="Thought elapsed time"
            prefix=" · "
            formatter={formatThoughtDuration}
          />
        </>
      )
    : elapsedMs === undefined
      ? "Thought"
      : `Thought for ${formatThoughtDuration(elapsedMs)}`;

  return (
    <div className="thought-block" data-active={active} data-open={open}>
      <button
        className="thought-heading"
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="thought-label">
          <Icon name="chevron-down" size={13} />
          <span>{label}</span>
        </span>
      </button>
      <div className="thought-content" id={contentId} aria-hidden={!open}>
        <div>{thought && <p>{thought}</p>}</div>
      </div>
    </div>
  );
}

export function PlanBlock({ entries, active }: { entries: PlanEntry[]; active: boolean }) {
  const [open, setOpen] = useState(active);
  const contentId = useId();
  const currentEntry = entries.find((entry) => entry.status === "in_progress")
    ?? entries.find((entry) => entry.status === "pending");
  const completedCount = entries.filter((entry) => entry.status === "completed").length;
  const summary = active && currentEntry
    ? currentEntry.content
    : `${completedCount}/${entries.length} plan steps complete`;

  useEffect(() => {
    if (active) setOpen(true);
    else if (completedCount === entries.length) setOpen(false);
  }, [active, completedCount, entries.length]);

  return (
    <div className="progress-disclosure plan-disclosure" data-open={open}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="progress-disclosure-label">
          <Icon name="chevron-down" size={13} /> PLAN
        </span>
        <span className="progress-disclosure-summary">{summary}</span>
      </button>
      <div className="progress-disclosure-content" id={contentId} aria-hidden={!open}>
        <div>
          {entries.map((entry, index) => (
            <div className="plan-row" key={`${entry.content}-${index}`}>
              <i className={entry.status} />
              <span>{entry.content}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function fileNameFromPath(path: string) {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function ToolStatusIcon({ tool }: { tool: ToolActivity }) {
  if (tool.status === "completed") return <Icon name="check" size={13} />;
  if (tool.status === "failed" || tool.status === "cancelled") {
    return <Icon name="x" size={13} />;
  }
  return <Icon name="terminal" size={13} />;
}

function ToolDetailRow({ tool }: { tool: ToolActivity }) {
  const active = isActiveToolStatus(tool.status);

  return (
    <div className={`activity-row ${tool.status}`}>
      <span className="activity-icon"><ToolStatusIcon tool={tool} /></span>
      <span className="activity-copy">
        <strong>{tool.title}</strong>
        {tool.locations && tool.locations.length > 0 && (
          <small>
            {tool.locations.map((location) => fileNameFromPath(location.path)).join(", ")}
          </small>
        )}
      </span>
      <span className="activity-detail">
        <span>{tool.status.replace(/_/g, " ")}</span>
        <DurationText
          timing={tool}
          active={active}
          label={`${tool.title} elapsed time`}
          prefix=" · "
        />
      </span>
    </div>
  );
}

function ToolGroupBlock({ tools }: { tools: ToolActivity[] }) {
  const interruptedCount = tools.filter((tool) => (
    tool.status === "failed" || tool.status === "cancelled"
  )).length;
  const active = tools.some((tool) => isActiveToolStatus(tool.status));
  const timing = combineTimings(tools);
  const [open, setOpen] = useState(interruptedCount > 0);
  const contentId = useId();

  useEffect(() => {
    if (interruptedCount > 0) setOpen(true);
  }, [interruptedCount]);

  return (
    <div
      className={`progress-disclosure tool-group-disclosure ${interruptedCount > 0 ? "has-failure" : ""}`}
      data-open={open}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="progress-disclosure-label" aria-hidden="true">
          <Icon name="chevron-down" size={13} />
        </span>
        <span className="progress-disclosure-summary">{toolGroupSummary(tools)}</span>
        <DurationText
          timing={timing}
          active={active}
          className="trace-duration"
          label="Event group elapsed time"
        />
      </button>
      <div className="progress-disclosure-content" id={contentId} aria-hidden={!open}>
        <div>{tools.map((tool) => <ToolDetailRow tool={tool} key={tool.id} />)}</div>
      </div>
    </div>
  );
}

function ToolBlock({ tool }: { tool: ToolActivity }) {
  const interrupted = tool.status === "failed" || tool.status === "cancelled";
  const active = isActiveToolStatus(tool.status);
  const [open, setOpen] = useState(interrupted);
  const contentId = useId();
  const statusLabel = tool.status.replace(/_/g, " ");

  useEffect(() => {
    if (interrupted) setOpen(true);
  }, [interrupted]);

  return (
    <div className={`progress-disclosure tool-call-disclosure ${tool.status}`} data-open={open}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="progress-disclosure-label" aria-hidden="true">
          <Icon name="chevron-down" size={13} />
        </span>
        <span className="progress-disclosure-summary">{tool.title}</span>
        <span className="trace-meta">
          <DurationText
            timing={tool}
            active={active}
            className="trace-duration"
            label={`${tool.title} elapsed time`}
          />
          <span className="trace-status" aria-label={statusLabel} title={statusLabel}>
            {tool.status === "completed"
              ? <Icon name="check" size={12} />
              : interrupted
                ? <Icon name="x" size={12} />
                : <span className="trace-status-pulse" />}
          </span>
        </span>
      </button>
      <div className="progress-disclosure-content" id={contentId} aria-hidden={!open}>
        <div className="tool-call-detail">
          <code>{tool.title}</code>
          <div>
            <span>{statusLabel}</span>
            {tool.locations && tool.locations.length > 0 && (
              <small>
                {tool.locations.map((location) => fileNameFromPath(location.path)).join(", ")}
              </small>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SteeringMarker({ item }: { item: Extract<TurnTimelineItem, { kind: "steer" }> }) {
  return (
    <div className="steering-marker">
      <Icon name="arrow-right" size={13} />
      <span>
        <small>You steered</small>
        <strong>{item.text}</strong>
      </span>
    </div>
  );
}

function TraceItems({
  items,
  messageState,
}: {
  items: TraceTimelineItem[];
  messageState?: ConversationState;
}) {
  return items.map((item) => {
    if (item.kind === "thought") {
      return (
        <ThoughtBlock
          key={item.id}
          thought={item.text}
          active={messageState === "streaming" && item.open}
          startedAt={item.startedAt}
          endedAt={item.endedAt}
          elapsedMs={item.elapsedMs}
        />
      );
    }
    if (item.kind === "tool_group") {
      return <ToolGroupBlock key={item.id} tools={item.tools} />;
    }
    if (item.kind === "tool") return <ToolBlock key={item.id} tool={item.tool} />;
    if (!item.decision) return null;

    return (
      <div className={`permission-decision ${item.decision.outcome}`} key={item.id}>
        <Icon name={item.decision.outcome === "allowed" ? "check" : "x"} size={13} />
        <span>{item.decision.label}</span>
        <small>{item.decision.title}</small>
        <DurationText timing={item} className="trace-duration" label="Permission wait time" />
      </div>
    );
  });
}

function CollapsedTraceBlock({
  items,
  messageState,
}: {
  items: TraceTimelineItem[];
  messageState?: ConversationState;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const { count, running, interrupted } = traceGroupDetails(items);
  const timing = combineTimings(items.map(traceItemTiming));
  const active = messageState === "streaming"
    && timing.startedAt !== undefined
    && timing.endedAt === undefined;
  const summary = [
    `${count} execution ${count === 1 ? "event" : "events"}`,
    interrupted > 0 ? `${interrupted} interrupted` : null,
  ].filter(Boolean).join(" · ");
  const status = interrupted > 0
    ? "interrupted"
    : running > 0
      ? "in progress"
      : "completed";

  return (
    <div
      className={`progress-disclosure turn-trace trace-group-disclosure ${interrupted > 0 ? "has-interruption" : ""}`}
      data-open={open}
      role="group"
      aria-label="Collapsed execution trace"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="progress-disclosure-label" aria-hidden="true">
          <Icon name="chevron-down" size={13} />
        </span>
        <span className="progress-disclosure-summary">{summary}</span>
        <span className="trace-meta">
          <DurationText
            timing={timing}
            active={active}
            className="trace-duration"
            label="Execution group elapsed time"
          />
          <span className="trace-status" aria-label={status} title={status}>
            {interrupted > 0
              ? <Icon name="x" size={12} />
              : running > 0
                ? <span className="trace-status-pulse" />
                : <Icon name="check" size={12} />}
          </span>
        </span>
      </button>
      <div className="progress-disclosure-content" id={contentId} aria-hidden={!open}>
        <div>
          <div className="turn-trace trace-group-items">
            <TraceItems items={items} messageState={messageState} />
          </div>
        </div>
      </div>
    </div>
  );
}

function turnStatusMessage(message: ConversationMessage, duration: string | null) {
  switch (message.state) {
    case "cancelled":
      return duration
        ? `Turn cancelled by user in ${duration}.`
        : "Turn cancelled by user.";
    case "refused":
      return "Grok declined this request.";
    case "limited":
      return message.stopReason === "max_tokens"
        ? "Stopped at the token limit."
        : "Stopped at the turn limit.";
    case "error":
      return message.error ?? (duration ? `Turn failed in ${duration}.` : "Turn failed.");
    default:
      return duration ? `Worked for ${duration}.` : "Turn completed.";
  }
}

function TurnStatusBlock({ message }: { message: ConversationMessage }) {
  if (!message.state || message.state === "streaming") return null;

  const duration = message.elapsedMs === undefined ? null : formatDuration(message.elapsedMs);
  const metadata = [
    message.metrics?.totalTokens != null
      ? `${formatTokenCount(message.metrics.totalTokens)} tokens`
      : null,
    message.metrics?.modelCalls != null
      ? `${message.metrics.modelCalls} ${message.metrics.modelCalls === 1 ? "model call" : "model calls"}`
      : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className={`turn-status ${message.state}`}>
      <span>{turnStatusMessage(message, duration)}</span>
      {metadata && <small>{metadata}</small>}
    </div>
  );
}

function UserMessage({ message }: { message: ConversationMessage }) {
  return (
    <div className="user-message" data-history-message-id={message.id}>
      <div className="user-message-heading">
        <span className="message-kicker">REQUEST</span>
        {message.text && <MessageCopyButton text={message.text} subject="request" />}
      </div>
      {message.text && <div className="user-message-copy">{message.text}</div>}
      {message.attachments && message.attachments.length > 0 && (
        <div className="message-attachments" aria-label="Attached files">
          {message.attachments.map((attachment, index) => (
            <span className="message-attachment" key={`${attachment.name}-${index}`}>
              <Icon name="paperclip" size={12} />
              <span>{attachment.name}</span>
              <small>{formatFileSize(attachment.size)}</small>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function timelineForMessage(message: ConversationMessage) {
  const timeline = message.timeline ?? [];
  const hasResponse = timeline.some((item) => item.kind === "response");

  if (hasResponse || !message.text) return timeline;

  return [
    ...timeline,
    { id: `${message.id}-response`, kind: "response" as const, text: message.text },
  ];
}

export function ConversationItem({ message }: { message: ConversationMessage }) {
  if (message.role === "user") return <UserMessage message={message} />;

  const timeline = timelineForMessage(message);
  const timelineSections = sectionTimeline(projectTimeline(timeline));
  const lastResponseId = [...timeline].reverse().find((item) => item.kind === "response")?.id;

  return (
    <article className={`assistant-turn ${message.state ?? "complete"}`}>
      {timelineSections.map((section, sectionIndex) => {
        if (section.kind === "response") {
          const response = section.item;

          return (
            <div className="assistant-response" key={response.id}>
              <div className="response-copy">
                <MarkdownContent>{response.text}</MarkdownContent>
              </div>
              {response.id === lastResponseId && (
                <div className="assistant-message-actions">
                  <MessageCopyButton
                    text={message.text || response.text}
                    subject="response"
                  />
                </div>
              )}
            </div>
          );
        }

        if (section.kind === "steer") {
          return <SteeringMarker item={section.item} key={section.id} />;
        }

        const items = visibleTraceItems(section.items, message.state);
        if (items.length === 0) return null;

        const isBetweenResponses = timelineSections[sectionIndex - 1]?.kind === "response"
          && timelineSections[sectionIndex + 1]?.kind === "response";
        if (isBetweenResponses) {
          return (
            <CollapsedTraceBlock
              key={section.id}
              items={items}
              messageState={message.state}
            />
          );
        }

        return (
          <div className="turn-trace" role="group" aria-label="Execution trace" key={section.id}>
            <TraceItems items={items} messageState={message.state} />
          </div>
        );
      })}

      <TurnStatusBlock message={message} />
    </article>
  );
}

function permissionOptionClass(kind: string) {
  switch (kind) {
    case "allow_once":
      return "allow-once";
    case "allow_always":
      return "allow-always";
    case "reject_always":
      return "reject reject-always";
    case "reject_once":
      return "reject";
    default:
      return kind.includes("reject") ? "reject" : "allow-once";
  }
}

export function PermissionCard({
  permission,
  busy,
  onRespond,
}: {
  permission: PermissionRequest;
  busy: boolean;
  onRespond: (optionId: string | null) => void;
}) {
  const hasRejectOption = permission.options.some((option) => (
    option.kind.startsWith("reject")
  ));

  return (
    <aside className="permission-card" aria-live="assertive">
      <div className="permission-glyph">!</div>
      <div className="permission-copy">
        <span className="message-kicker">APPROVAL REQUIRED</span>
        <strong>{permission.title}</strong>
        <small>{permission.toolKind?.replace(/_/g, " ") ?? "Local tool action"}</small>
        <div className="permission-actions">
          {permission.options.map((option) => (
            <button
              className={permissionOptionClass(option.kind)}
              type="button"
              disabled={busy}
              key={option.optionId}
              onClick={() => onRespond(option.optionId)}
            >
              {busy ? "Responding…" : option.name}
            </button>
          ))}
          {!hasRejectOption && (
            <button
              className="reject"
              type="button"
              disabled={busy}
              onClick={() => onRespond(null)}
            >
              Cancel request
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
