import assert from "node:assert/strict";
import test from "node:test";
import {
  projectTimeline,
  sectionTimeline,
  toolGroupSummary,
  traceGroupDetails,
  visibleTraceItems,
} from "../src/session/timeline.ts";
import type { ToolActivity, TurnTimelineItem } from "../src/session/types.ts";

function tool(id: string, kind: string, status: ToolActivity["status"]): ToolActivity {
  return { id, kind, status, title: `${kind} ${id}` };
}

test("groups adjacent read and search tools while preserving response boundaries", () => {
  const timeline: TurnTimelineItem[] = [
    { id: "read-1", kind: "tool", tool: tool("read-1", "read", "completed") },
    { id: "search-1", kind: "tool", tool: tool("search-1", "search", "completed") },
    { id: "response-1", kind: "response", text: "First response" },
    { id: "edit-1", kind: "tool", tool: tool("edit-1", "edit", "completed") },
    { id: "response-2", kind: "response", text: "Second response" },
  ];

  const projected = projectTimeline(timeline);
  const sections = sectionTimeline(projected);

  assert.equal(projected[0]?.kind, "tool_group");
  if (projected[0]?.kind === "tool_group") {
    assert.deepEqual(projected[0].tools.map((entry) => entry.id), ["read-1", "search-1"]);
  }
  assert.deepEqual(sections.map((section) => section.kind), [
    "trace",
    "response",
    "trace",
    "response",
  ]);
});

test("summarizes grouped tools with active and interrupted states", () => {
  const tools = [
    { ...tool("one", "read", "in_progress"), title: "src/App.tsx" },
    { ...tool("two", "read", "failed"), title: "src/main.tsx" },
    { ...tool("three", "search", "cancelled"), title: "search files" },
  ];

  assert.equal(
    toolGroupSummary(tools),
    "Reading 2 files, Searching 1 pattern, 1 failed, 1 cancelled",
  );

  const details = traceGroupDetails([{ id: "group", kind: "tool_group", tools }]);
  assert.deepEqual(details, { count: 3, running: 1, interrupted: 2 });
});

test("hides empty thoughts and unresolved permissions from a completed trace", () => {
  const items = [
    { id: "thought", kind: "thought" as const, text: "", open: false },
    {
      id: "permission",
      kind: "permission" as const,
      requestId: "request-1",
      toolCallId: "tool-1",
      title: "Write file",
    },
    { id: "tool", kind: "tool" as const, tool: tool("tool-1", "edit", "completed") },
  ];

  assert.deepEqual(visibleTraceItems(items, "complete"), [items[2]]);
  assert.deepEqual(visibleTraceItems([items[0]], "streaming"), []);
});
