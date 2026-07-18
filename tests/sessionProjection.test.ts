import assert from "node:assert/strict";
import test from "node:test";
import {
  addFallbackThought,
  applySessionUpdateToMessage,
  reconcileFallbackResponse,
  sessionReplayProjection,
} from "../src/session/projection.ts";
import type {
  ConversationMessage,
  SessionUpdate,
} from "../src/session/types.ts";

function sequentialIds() {
  let nextId = 0;
  return (prefix: string) => `${prefix}-${++nextId}`;
}

function streamingMessage(): ConversationMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    text: "",
    state: "streaming",
    startedAt: 1_000,
  };
}

test("projects thought, tool, response, and completion updates into one readable timeline", () => {
  const createMessageId = sequentialIds();
  const updates: SessionUpdate[] = [
    { sessionId: "session-1", kind: "agent_thought_chunk", text: "Inspecting" },
    {
      sessionId: "session-1",
      kind: "tool_call",
      toolCallId: "tool-1",
      title: "Read src/App.tsx",
      toolKind: "read",
      status: "in_progress",
      locations: [{ path: "src/App.tsx", line: 1 }],
    },
    {
      sessionId: "session-1",
      kind: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
    },
    { sessionId: "session-1", kind: "agent_message_chunk", text: "Done" },
    { sessionId: "session-1", kind: "turn_completed", stopReason: "end_turn" },
  ];

  const projected = updates.reduce(
    (message, update, index) => applySessionUpdateToMessage(
      message,
      update,
      1_100 + index * 100,
      createMessageId,
    ),
    streamingMessage(),
  );

  assert.equal(projected.state, "complete");
  assert.equal(projected.text, "Done");
  assert.equal(projected.elapsedMs, 500);
  assert.deepEqual(projected.timeline, [
    {
      id: "thought-1",
      kind: "thought",
      text: "Inspecting",
      open: false,
      startedAt: 1_100,
      endedAt: 1_200,
      elapsedMs: 100,
    },
    {
      id: "tool-2",
      kind: "tool",
      tool: {
        id: "tool-1",
        title: "Read src/App.tsx",
        kind: "read",
        status: "completed",
        locations: [{ path: "src/App.tsx", line: 1 }],
        startedAt: 1_200,
        endedAt: 1_300,
        elapsedMs: 100,
      },
    },
    { id: "response-3", kind: "response", text: "Done" },
  ]);
});

test("records one permission request and resolves it in place", () => {
  const createMessageId = sequentialIds();
  const request: SessionUpdate = {
    sessionId: "session-1",
    kind: "permission_requested",
    requestId: "permission-1",
    toolCallId: "tool-1",
    title: "Write src/App.tsx",
    toolKind: "edit",
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  };
  const decision: SessionUpdate = {
    sessionId: "session-1",
    kind: "permission_decision",
    requestId: "permission-1",
    toolCallId: "tool-1",
    title: "Write src/App.tsx",
    label: "Allow",
    outcome: "allowed",
  };

  const requested = applySessionUpdateToMessage(
    streamingMessage(),
    request,
    1_200,
    createMessageId,
  );
  const duplicated = applySessionUpdateToMessage(requested, request, 1_300, createMessageId);
  const resolved = applySessionUpdateToMessage(duplicated, decision, 1_500, createMessageId);

  assert.equal(duplicated.timeline?.length, 1);
  assert.deepEqual(resolved.timeline, [{
    id: "permission-1",
    kind: "permission",
    requestId: "permission-1",
    toolCallId: "tool-1",
    title: "Write src/App.tsx",
    startedAt: 1_200,
    endedAt: 1_500,
    elapsedMs: 300,
    decision: {
      requestId: "permission-1",
      toolCallId: "tool-1",
      title: "Write src/App.tsx",
      label: "Allow",
      outcome: "allowed",
    },
  }]);
});

test("replays only the requested session and projects its latest metadata", () => {
  const updates: SessionUpdate[] = [
    { sessionId: "other", kind: "user_message_chunk", text: "Ignore me" },
    {
      sessionId: "session-1",
      kind: "user_message_chunk",
      text: "Review ",
      attachments: [{ name: "App.tsx", size: 100 }],
    },
    { sessionId: "session-1", kind: "user_message_chunk", text: "this" },
    { sessionId: "session-1", kind: "agent_message_chunk", text: "Looks good" },
    {
      sessionId: "session-1",
      kind: "available_commands_update",
      availableCommands: [{ name: "/review", description: "Review code" }],
    },
    { sessionId: "session-1", kind: "current_mode_update", currentModeId: "code" },
    {
      sessionId: "session-1",
      kind: "usage_update",
      used: 20,
      size: 100,
      cost: { amount: 0.1, currency: "USD" },
    },
    {
      sessionId: "session-1",
      kind: "session_info_update",
      title: "Readable review",
      updatedAt: "2026-07-18T00:00:00.000Z",
    },
  ];

  const projection = sessionReplayProjection("session-1", updates, {
    createMessageId: sequentialIds(),
    now: () => 10_000,
  });

  assert.equal(projection.messages.length, 2);
  assert.deepEqual(projection.messages[0], {
    id: "replayed-user-1",
    role: "user",
    text: "Review this",
    attachments: [{ name: "App.tsx", size: 100 }],
  });
  assert.equal(projection.messages[1]?.text, "Looks good");
  assert.equal(projection.title, "Readable review");
  assert.equal(projection.updatedAt, Date.parse("2026-07-18T00:00:00.000Z"));
  assert.equal(projection.currentModeId, "code");
  assert.deepEqual(projection.availableCommands, [
    { name: "/review", description: "Review code" },
  ]);
  assert.deepEqual(projection.usage, {
    used: 20,
    size: 100,
    cost: { amount: 0.1, currency: "USD" },
  });
});

test("keeps fallback output deterministic without duplicating streamed content", () => {
  const createMessageId = sequentialIds();
  const message: ConversationMessage = {
    ...streamingMessage(),
    text: "Hello",
    timeline: [{ id: "response-streamed", kind: "response", text: "Hello" }],
  };

  const withThought = addFallbackThought(message, "Reasoning", createMessageId);
  const reconciled = reconcileFallbackResponse(withThought, "Hello world", createMessageId);

  assert.equal(reconciled.text, "Hello world");
  assert.deepEqual(reconciled.timeline, [
    { id: "thought-1", kind: "thought", text: "Reasoning", open: false },
    { id: "response-streamed", kind: "response", text: "Hello world" },
  ]);
});
