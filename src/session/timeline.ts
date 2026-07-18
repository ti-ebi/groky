import { combineTimings, type EventTiming } from "../timing.ts";
import type {
  ConversationState,
  ToolActivity,
  TurnTimelineItem,
} from "./types.ts";

export type ToolVerbGroupKind =
  | "file"
  | "skill"
  | "pattern"
  | "dir"
  | "web_fetch"
  | "web_search"
  | "memory"
  | "integration";

export type ProjectedTimelineItem = TurnTimelineItem | {
  id: string;
  kind: "tool_group";
  tools: ToolActivity[];
};

export type ResponseTimelineItem = Extract<ProjectedTimelineItem, { kind: "response" }>;
export type SteerTimelineItem = Extract<ProjectedTimelineItem, { kind: "steer" }>;
export type TraceTimelineItem = Exclude<
  ProjectedTimelineItem,
  ResponseTimelineItem | SteerTimelineItem
>;

export type TimelineSection =
  | { id: string; kind: "response"; item: ResponseTimelineItem }
  | { id: string; kind: "steer"; item: SteerTimelineItem }
  | { id: string; kind: "trace"; items: TraceTimelineItem[] };

const TOOL_GROUP_WORDS: Record<
  ToolVerbGroupKind,
  { past: string; present: string; one: string; many: string }
> = {
  file: { past: "Read", present: "Reading", one: "file", many: "files" },
  skill: { past: "Read", present: "Reading", one: "skill", many: "skills" },
  pattern: { past: "Searched", present: "Searching", one: "pattern", many: "patterns" },
  dir: { past: "Listed", present: "Listing", one: "dir", many: "dirs" },
  web_fetch: { past: "Fetched", present: "Fetching", one: "website", many: "websites" },
  web_search: { past: "Searched", present: "Searching", one: "website", many: "websites" },
  memory: { past: "Searched", present: "Searching", one: "memory", many: "memories" },
  integration: { past: "Searched", present: "Searching", one: "MCP tool", many: "MCP tools" },
};

export function toolVerbGroupKind(tool: ToolActivity): ToolVerbGroupKind | null {
  const title = tool.title.toLocaleLowerCase();

  if (tool.kind === "read") {
    return /(?:^|[\\/])skills?(?:[\\/]|$)|skill\.md/.test(title) ? "skill" : "file";
  }
  if (tool.kind === "fetch") return "web_fetch";
  if (tool.kind === "search") {
    return /\b(web|x)\s*search\b|search(?:ing)? the web/.test(title)
      ? "web_search"
      : "pattern";
  }
  if (/\b(list[_ -]?dir|list directory|listing directory)\b/.test(title)) return "dir";
  if (/\b(memory[_ -]?search|search(?:ing)? memor)/.test(title)) return "memory";
  if (/\b(search[_ -]?tool|integration search|search(?:ing)? mcp)/.test(title)) {
    return "integration";
  }
  if (/\b(skill|skill\.md)\b/.test(title)) return "skill";

  return null;
}

export function projectTimeline(timeline: TurnTimelineItem[]): ProjectedTimelineItem[] {
  const projected: ProjectedTimelineItem[] = [];

  timeline.forEach((item) => {
    if (item.kind !== "tool" || toolVerbGroupKind(item.tool) === null) {
      projected.push(item);
      return;
    }

    const previousItem = projected[projected.length - 1];
    if (previousItem?.kind === "tool_group") {
      previousItem.tools.push(item.tool);
      return;
    }

    projected.push({
      id: `tool-group-${item.id}`,
      kind: "tool_group",
      tools: [item.tool],
    });
  });

  return projected;
}

export function sectionTimeline(timeline: ProjectedTimelineItem[]): TimelineSection[] {
  const sections: TimelineSection[] = [];

  timeline.forEach((item) => {
    if (item.kind === "response") {
      sections.push({ id: item.id, kind: "response", item });
      return;
    }
    if (item.kind === "steer") {
      sections.push({ id: item.id, kind: "steer", item });
      return;
    }

    const previousSection = sections[sections.length - 1];
    if (previousSection?.kind === "trace") {
      previousSection.items.push(item);
      return;
    }

    sections.push({ id: `trace-${item.id}`, kind: "trace", items: [item] });
  });

  return sections;
}

export function toolGroupSummary(tools: ToolActivity[]) {
  const running = tools.some((tool) => (
    tool.status === "pending" || tool.status === "in_progress"
  ));
  const buckets = new Map<ToolVerbGroupKind, number>();

  tools.forEach((tool) => {
    const kind = toolVerbGroupKind(tool);
    if (kind) buckets.set(kind, (buckets.get(kind) ?? 0) + 1);
  });

  const summary = Array.from(buckets, ([kind, count]) => {
    const words = TOOL_GROUP_WORDS[kind];
    const action = running ? words.present : words.past;
    const subject = count === 1 ? words.one : words.many;
    return `${action} ${count} ${subject}`;
  });
  const failed = tools.filter((tool) => tool.status === "failed").length;
  const cancelled = tools.filter((tool) => tool.status === "cancelled").length;

  if (failed) summary.push(`${failed} failed`);
  if (cancelled) summary.push(`${cancelled} cancelled`);

  return summary.join(", ");
}

export function traceGroupDetails(items: TraceTimelineItem[]) {
  let count = 0;
  let running = 0;
  let interrupted = 0;

  function countTool(tool: ToolActivity) {
    count += 1;
    if (tool.status === "pending" || tool.status === "in_progress") running += 1;
    if (tool.status === "failed" || tool.status === "cancelled") interrupted += 1;
  }

  items.forEach((item) => {
    if (item.kind === "tool_group") {
      item.tools.forEach(countTool);
      return;
    }

    if (item.kind === "tool") {
      countTool(item.tool);
      return;
    }

    count += 1;
    if (item.kind === "permission" && item.decision && item.decision.outcome !== "allowed") {
      interrupted += 1;
    }
  });

  return { count, running, interrupted };
}

export function traceItemTiming(item: TraceTimelineItem): EventTiming {
  if (item.kind === "tool_group") return combineTimings(item.tools);
  if (item.kind === "tool") return item.tool;
  return item;
}

export function visibleTraceItems(
  items: TraceTimelineItem[],
  messageState: ConversationState | undefined,
) {
  return items.filter((item) => {
    if (item.kind === "thought") {
      return Boolean(item.text.trim()) || (messageState === "streaming" && item.open);
    }

    return item.kind !== "permission" || item.decision !== undefined;
  });
}
