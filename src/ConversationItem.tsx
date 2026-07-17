import { useEffect, useId, useRef, useState } from "react";
import { copyToClipboard } from "./clipboard";
import { DurationText } from "./DurationText";
import { formatDuration, formatFileSize, formatThoughtDuration, formatTokenCount } from "./format";
import { Icon } from "./Icon";
import { MarkdownContent } from "./MarkdownContent";
import { isActiveToolStatus } from "./sessionProjection";
import type {
  ConversationMessage,
  ConversationState,
  ToolActivity,
  TurnTimelineItem,
} from "./sessionTypes";
import { combineTimings, type EventTiming } from "./timing";

function MessageCopyButton({ text, subject }: { text: string; subject: "request" | "response" }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const resetTimer = useRef<number | null>(null);
  const buttonLabel = copyState === "copied"
    ? `${subject === "request" ? "Request" : "Response"} copied`
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
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 2200);
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

  useEffect(() => {
    setOpen(active);
  }, [active]);

  if (!active && !thought.trim()) return null;

  return (
    <div className="thought-block" data-active={active} data-open={open}>
      <button
        className="thought-heading"
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="thought-label"><Icon name="chevron-down" size={13} /><span>{label}</span></span>
      </button>
      <div className="thought-content" id={contentId} aria-hidden={!open}>
        <div>{thought && <p>{thought}</p>}</div>
      </div>
    </div>
  );
}

function fileNameFromPath(path: string) {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

type ToolVerbGroupKind = "file" | "skill" | "pattern" | "dir" | "web_fetch" | "web_search" | "memory" | "integration";

type ProjectedTimelineItem = TurnTimelineItem | {
  id: string;
  kind: "tool_group";
  tools: ToolActivity[];
};

type ResponseTimelineItem = Extract<ProjectedTimelineItem, { kind: "response" }>;
type TraceTimelineItem = Exclude<ProjectedTimelineItem, ResponseTimelineItem>;
type TimelineSection =
  | { id: string; kind: "response"; item: ResponseTimelineItem }
  | { id: string; kind: "trace"; items: TraceTimelineItem[] };

function toolVerbGroupKind(tool: ToolActivity): ToolVerbGroupKind | null {
  const title = tool.title.toLocaleLowerCase();
  if (tool.kind === "read") return /(?:^|[\\/])skills?(?:[\\/]|$)|skill\.md/.test(title) ? "skill" : "file";
  if (tool.kind === "fetch") return "web_fetch";
  if (tool.kind === "search") return /\b(web|x)\s*search\b|search(?:ing)? the web/.test(title) ? "web_search" : "pattern";
  if (/\b(list[_ -]?dir|list directory|listing directory)\b/.test(title)) return "dir";
  if (/\b(memory[_ -]?search|search(?:ing)? memor)/.test(title)) return "memory";
  if (/\b(search[_ -]?tool|integration search|search(?:ing)? mcp)/.test(title)) return "integration";
  if (/\b(skill|skill\.md)\b/.test(title)) return "skill";
  return null;
}

function projectTimeline(timeline: TurnTimelineItem[]): ProjectedTimelineItem[] {
  const projected: ProjectedTimelineItem[] = [];
  timeline.forEach((item) => {
    if (item.kind !== "tool" || toolVerbGroupKind(item.tool) === null) {
      projected.push(item);
      return;
    }
    const last = projected[projected.length - 1];
    if (last?.kind === "tool_group") {
      last.tools.push(item.tool);
      return;
    }
    projected.push({ id: `tool-group-${item.id}`, kind: "tool_group", tools: [item.tool] });
  });
  return projected;
}

function sectionTimeline(timeline: ProjectedTimelineItem[]): TimelineSection[] {
  const sections: TimelineSection[] = [];
  timeline.forEach((item) => {
    if (item.kind === "response") {
      sections.push({ id: item.id, kind: "response", item });
      return;
    }
    const last = sections[sections.length - 1];
    if (last?.kind === "trace") {
      last.items.push(item);
      return;
    }
    sections.push({ id: `trace-${item.id}`, kind: "trace", items: [item] });
  });
  return sections;
}

const TOOL_GROUP_WORDS: Record<ToolVerbGroupKind, { past: string; present: string; one: string; many: string }> = {
  file: { past: "Read", present: "Reading", one: "file", many: "files" },
  skill: { past: "Read", present: "Reading", one: "skill", many: "skills" },
  pattern: { past: "Searched", present: "Searching", one: "pattern", many: "patterns" },
  dir: { past: "Listed", present: "Listing", one: "dir", many: "dirs" },
  web_fetch: { past: "Fetched", present: "Fetching", one: "website", many: "websites" },
  web_search: { past: "Searched", present: "Searching", one: "website", many: "websites" },
  memory: { past: "Searched", present: "Searching", one: "memory", many: "memories" },
  integration: { past: "Searched", present: "Searching", one: "MCP tool", many: "MCP tools" },
};

function toolGroupSummary(tools: ToolActivity[]) {
  const running = tools.some((tool) => tool.status === "pending" || tool.status === "in_progress");
  const buckets = new Map<ToolVerbGroupKind, number>();
  tools.forEach((tool) => {
    const kind = toolVerbGroupKind(tool);
    if (kind) buckets.set(kind, (buckets.get(kind) ?? 0) + 1);
  });
  const summary = Array.from(buckets, ([kind, count]) => {
    const words = TOOL_GROUP_WORDS[kind];
    return `${running ? words.present : words.past} ${count} ${count === 1 ? words.one : words.many}`;
  });
  const failed = tools.filter((tool) => tool.status === "failed").length;
  const cancelled = tools.filter((tool) => tool.status === "cancelled").length;
  if (failed) summary.push(`${failed} failed`);
  if (cancelled) summary.push(`${cancelled} cancelled`);
  return summary.join(", ");
}

function ToolDetailRow({ tool }: { tool: ToolActivity }) {
  const active = isActiveToolStatus(tool.status);
  return (
    <div className={`activity-row ${tool.status}`}>
      <span className="activity-icon">
        {tool.status === "completed"
          ? <Icon name="check" size={13} />
          : tool.status === "failed" || tool.status === "cancelled"
            ? <Icon name="x" size={13} />
            : <Icon name="terminal" size={13} />}
      </span>
      <span className="activity-copy">
        <strong>{tool.title}</strong>
        {tool.locations && tool.locations.length > 0 && (
          <small>{tool.locations.map((location) => fileNameFromPath(location.path)).join(", ")}</small>
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
  const failed = tools.filter((tool) => tool.status === "failed");
  const cancelled = tools.filter((tool) => tool.status === "cancelled");
  const interrupted = failed.length + cancelled.length;
  const active = tools.some((tool) => isActiveToolStatus(tool.status));
  const timing = combineTimings(tools);
  const [open, setOpen] = useState(interrupted > 0);
  const contentId = useId();

  useEffect(() => {
    if (interrupted > 0) setOpen(true);
  }, [interrupted]);

  return (
    <div className={`progress-disclosure tool-group-disclosure ${interrupted > 0 ? "has-failure" : ""}`} data-open={open}>
      <button type="button" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen((value) => !value)}>
        <span className="progress-disclosure-label" aria-hidden="true"><Icon name="chevron-down" size={13} /></span>
        <span className="progress-disclosure-summary">{toolGroupSummary(tools)}</span>
        <DurationText
          timing={timing}
          active={active}
          className="trace-duration"
          label="Event group elapsed time"
        />
      </button>
      <div className="progress-disclosure-content" id={contentId} aria-hidden={!open}>
        <div>
          {tools.map((tool) => <ToolDetailRow tool={tool} key={tool.id} />)}
        </div>
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
    <div
      className={`progress-disclosure tool-call-disclosure ${tool.status}`}
      data-open={open}
    >
      <button type="button" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen((value) => !value)}>
        <span className="progress-disclosure-label" aria-hidden="true"><Icon name="chevron-down" size={13} /></span>
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
              <small>{tool.locations.map((location) => fileNameFromPath(location.path)).join(", ")}</small>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TraceItems({ items, messageState }: { items: TraceTimelineItem[]; messageState?: ConversationState }) {
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

function traceGroupDetails(items: TraceTimelineItem[]) {
  let count = 0;
  let running = 0;
  let interrupted = 0;
  items.forEach((item) => {
    if (item.kind === "tool_group") {
      count += item.tools.length;
      item.tools.forEach((tool) => {
        if (tool.status === "pending" || tool.status === "in_progress") running += 1;
        if (tool.status === "failed" || tool.status === "cancelled") interrupted += 1;
      });
      return;
    }
    count += 1;
    if (item.kind === "tool") {
      if (item.tool.status === "pending" || item.tool.status === "in_progress") running += 1;
      if (item.tool.status === "failed" || item.tool.status === "cancelled") interrupted += 1;
    }
    if (item.kind === "permission" && item.decision && item.decision.outcome !== "allowed") interrupted += 1;
  });
  return { count, running, interrupted };
}

function traceItemTiming(item: TraceTimelineItem): EventTiming {
  if (item.kind === "tool_group") return combineTimings(item.tools);
  if (item.kind === "tool") return item.tool;
  return item;
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
  const summary = `${count} execution ${count === 1 ? "event" : "events"}${interrupted > 0 ? ` · ${interrupted} interrupted` : ""}`;
  const status = interrupted > 0 ? "interrupted" : running > 0 ? "in progress" : "completed";

  return (
    <div
      className={`progress-disclosure turn-trace trace-group-disclosure ${interrupted > 0 ? "has-interruption" : ""}`}
      data-open={open}
      role="group"
      aria-label="Collapsed execution trace"
    >
      <button type="button" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen((value) => !value)}>
        <span className="progress-disclosure-label" aria-hidden="true"><Icon name="chevron-down" size={13} /></span>
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

function TurnStatusBlock({ message }: { message: ConversationMessage }) {
  if (!message.state || message.state === "streaming") return null;
  const duration = message.elapsedMs === undefined ? null : formatDuration(message.elapsedMs);
  const status = message.state === "cancelled"
    ? duration ? `Turn cancelled by user in ${duration}.` : "Turn cancelled by user."
    : message.state === "refused"
      ? "Grok declined this request."
      : message.state === "limited"
        ? message.stopReason === "max_tokens" ? "Stopped at the token limit." : "Stopped at the turn limit."
        : message.state === "error"
          ? message.error ?? (duration ? `Turn failed in ${duration}.` : "Turn failed.")
          : duration ? `Worked for ${duration}.` : "Turn completed.";
  const metadata = [
    message.metrics?.totalTokens != null ? `${formatTokenCount(message.metrics.totalTokens)} tokens` : null,
    message.metrics?.modelCalls != null
      ? `${message.metrics.modelCalls} ${message.metrics.modelCalls === 1 ? "model call" : "model calls"}`
      : null,
  ].filter(Boolean).join(" · ");
  return (
    <div className={`turn-status ${message.state}`}>
      <span>{status}</span>
      {metadata && <small>{metadata}</small>}
    </div>
  );
}

export function ConversationItem({ message }: { message: ConversationMessage }) {
  if (message.role === "user") {
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

  const sourceTimeline = message.timeline ?? [];
  const timeline = sourceTimeline.some((item) => item.kind === "response") || !message.text
    ? sourceTimeline
    : [...sourceTimeline, { id: `${message.id}-response`, kind: "response" as const, text: message.text }];
  const projectedTimeline = projectTimeline(timeline);
  const timelineSections = sectionTimeline(projectedTimeline);
  const lastResponseId = [...timeline].reverse().find((item) => item.kind === "response")?.id;

  return (
    <article className={`assistant-turn ${message.state ?? "complete"}`}>
      {timelineSections.map((section, sectionIndex) => {
        if (section.kind === "response") {
          const item = section.item;
          return (
            <div className="assistant-response" key={item.id}>
              <div className="response-copy"><MarkdownContent>{item.text}</MarkdownContent></div>
              {item.id === lastResponseId && (
                <div className="assistant-message-actions">
                  <MessageCopyButton text={message.text || item.text} subject="response" />
                </div>
              )}
            </div>
          );
        }
        const items = section.items.filter((item) => {
          if (item.kind === "thought") {
            return Boolean(item.text.trim()) || (message.state === "streaming" && item.open);
          }
          return item.kind !== "permission" || item.decision !== undefined;
        });
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
