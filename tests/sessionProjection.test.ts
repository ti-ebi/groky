import assert from "node:assert/strict";
import test from "node:test";
import {
  applySessionUpdateToMessage,
  conversationTurnPreviews,
  sessionReplayProjection,
} from "../src/sessionProjection.ts";
import type {
  ConversationMessage,
  SessionUpdate,
} from "../src/sessionTypes.ts";

test("projects streaming thought, response, and tool updates without losing their order", () => {
  const sessionId = "session-1";
  const initial: ConversationMessage = {
    id: "assistant-1",
    role: "assistant",
    text: "",
    state: "streaming",
    startedAt: 1_000,
  };
  const updates: SessionUpdate[] = [
    { sessionId, kind: "agent_thought_chunk", text: "Checking" },
    { sessionId, kind: "agent_message_chunk", text: "Done" },
    {
      sessionId,
      kind: "tool_call",
      toolCallId: "tool-1",
      title: "Read src/App.tsx",
      toolKind: "read",
      status: "in_progress",
      locations: [{ path: "src/App.tsx" }],
    },
    {
      sessionId,
      kind: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
    },
    {
      sessionId,
      kind: "turn_completed",
      stopReason: "end_turn",
      metrics: { totalTokens: 42 },
    },
  ];

  const projected = updates.reduce(
    (message, update, index) => applySessionUpdateToMessage(message, update, 2_000 + index * 100),
    initial,
  );

  assert.equal(projected.text, "Done");
  assert.equal(projected.state, "complete");
  assert.equal(projected.elapsedMs, 1_400);
  assert.equal(projected.metrics?.totalTokens, 42);
  assert.deepEqual(projected.timeline?.map((item) => item.kind), ["thought", "response", "tool"]);

  const thought = projected.timeline?.[0];
  assert.equal(thought?.kind, "thought");
  if (thought?.kind === "thought") {
    assert.equal(thought.open, false);
    assert.equal(thought.elapsedMs, 100);
  }

  const tool = projected.timeline?.[2];
  assert.equal(tool?.kind, "tool");
  if (tool?.kind === "tool") {
    assert.equal(tool.tool.status, "completed");
    assert.equal(tool.tool.elapsedMs, 100);
    assert.deepEqual(tool.tool.locations, [{ path: "src/App.tsx" }]);
  }
});

test("replays only the requested session and projects session metadata", () => {
  const updates: SessionUpdate[] = [
    { sessionId: "other", kind: "user_message_chunk", text: "Ignore me" },
    { sessionId: "session-1", kind: "user_message_chunk", text: "Review " },
    {
      sessionId: "session-1",
      kind: "user_message_chunk",
      text: "this",
      attachments: [{ name: "App.tsx", size: 100 }],
    },
    { sessionId: "session-1", kind: "agent_message_chunk", text: "Looks good." },
    {
      sessionId: "session-1",
      kind: "available_commands_update",
      availableCommands: [{ name: "review", description: "Review changes" }],
    },
    { sessionId: "session-1", kind: "current_mode_update", currentModeId: "code" },
    {
      sessionId: "session-1",
      kind: "config_option_update",
      configOptions: [{ id: "safe", name: "Safe mode", value: true }],
    },
    { sessionId: "session-1", kind: "usage_update", used: 12, size: 100 },
    {
      sessionId: "session-1",
      kind: "plan",
      entries: [{ content: "Inspect", status: "completed" }],
    },
    {
      sessionId: "session-1",
      kind: "session_info_update",
      title: "Review App",
      updatedAt: "2026-07-17T00:00:00.000Z",
    },
  ];

  const replay = sessionReplayProjection("session-1", updates, () => 5_000);

  assert.equal(replay.messages.length, 2);
  assert.equal(replay.messages[0].text, "Review this");
  assert.deepEqual(replay.messages[0].attachments, [{ name: "App.tsx", size: 100 }]);
  assert.equal(replay.messages[1].text, "Looks good.");
  assert.equal(replay.messages[1].state, "historical");
  assert.equal(replay.availableCommands?.[0].name, "review");
  assert.equal(replay.currentModeId, "code");
  assert.equal(replay.configOptions[0].value, true);
  assert.deepEqual(replay.usage, { used: 12, size: 100, cost: undefined });
  assert.deepEqual(replay.plan, [{ content: "Inspect", status: "completed" }]);
  assert.equal(replay.title, "Review App");
  assert.equal(replay.updatedAt, Date.parse("2026-07-17T00:00:00.000Z"));
});

test("keeps pending permissions in replay state until their decision arrives", () => {
  const requested: SessionUpdate = {
    sessionId: "session-1",
    kind: "permission_requested",
    requestId: "permission-1",
    toolCallId: "tool-1",
    title: "Run tests",
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  };
  const decision: SessionUpdate = {
    sessionId: "session-1",
    kind: "permission_decision",
    requestId: "permission-1",
    toolCallId: "tool-1",
    title: "Run tests",
    label: "Allowed",
    outcome: "allowed",
  };

  const pending = sessionReplayProjection("session-1", [requested], () => 1_000);
  assert.equal(pending.permissions.length, 1);

  const resolved = sessionReplayProjection("session-1", [requested, decision], () => 1_000);
  assert.equal(resolved.permissions.length, 0);
  const permission = resolved.messages[0].timeline?.find((item) => item.kind === "permission");
  assert.equal(permission?.kind, "permission");
  if (permission?.kind === "permission") {
    assert.equal(permission.decision?.outcome, "allowed");
  }
});

test("builds compact conversation previews for text and attachment-only requests", () => {
  const previews = conversationTurnPreviews([
    { id: "user-1", role: "user", text: "", attachments: [{ name: "diagram.png", size: 10 }] },
    { id: "assistant-1", role: "assistant", text: "", state: "cancelled" },
  ]);

  assert.deepEqual(previews, [{
    id: "user-1",
    request: "diagram.png",
    response: "This turn was cancelled before a response was returned.",
  }]);
});
