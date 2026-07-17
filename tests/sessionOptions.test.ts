import assert from "node:assert/strict";
import test from "node:test";
import {
  enablesAlwaysApprove,
  selectModelInState,
  selectReasoningInState,
} from "../src/sessionOptions.ts";
import {
  compareSidebarSessions,
  groupSidebarSessions,
} from "../src/sidebarSessions.ts";
import type {
  SessionModelState,
  SidebarSessionSummary,
} from "../src/sessionTypes.ts";

const session = (
  sessionId: string,
  overrides: Partial<SidebarSessionSummary> = {},
): SidebarSessionSummary => ({
  sessionId,
  title: sessionId,
  workspace: null,
  running: false,
  needsAttention: false,
  updatedAt: 0,
  archived: false,
  unread: false,
  ...overrides,
});

test("orders attention and unread sessions before recent idle sessions", () => {
  const sessions = [
    session("recent", { updatedAt: 30 }),
    session("unread", { unread: true, updatedAt: 10 }),
    session("attention", { needsAttention: true, updatedAt: 5 }),
    session("running", { running: true, updatedAt: 20 }),
  ];

  assert.deepEqual(
    sessions.sort(compareSidebarSessions).map((entry) => entry.sessionId),
    ["attention", "unread", "running", "recent"],
  );
});

test("groups workspace sessions while preserving standalone sessions", () => {
  const grouped = groupSidebarSessions([
    session("standalone"),
    session("one", { workspace: "/workspace/a" }),
    session("two", { workspace: "/workspace/a" }),
    session("three", { workspace: "/workspace/b" }),
  ]);

  assert.deepEqual(grouped.ungrouped.map((entry) => entry.sessionId), ["standalone"]);
  assert.deepEqual(
    grouped.workspaceGroups.map((group) => [group.path, group.sessions.map((entry) => entry.sessionId)]),
    [
      ["/workspace/a", ["one", "two"]],
      ["/workspace/b", ["three"]],
    ],
  );
});

test("updates model and reasoning selections without mutating the prior state", () => {
  const models: SessionModelState = {
    currentModelId: "model-a",
    availableModels: [
      { modelId: "model-a", name: "A", metadata: { reasoningEffort: "low" } },
      { modelId: "model-b", name: "B", metadata: { reasoningEffort: "high" } },
    ],
  };

  const selected = selectModelInState(models, "model-b");
  const reasoned = selectReasoningInState(models, "medium");

  assert.equal(models.currentModelId, "model-a");
  assert.equal(selected.currentModelId, "model-b");
  assert.equal(reasoned.availableModels[0].metadata?.reasoningEffort, "medium");
  assert.equal(reasoned.availableModels[1].metadata?.reasoningEffort, "high");
});

test("recognizes only explicit always-approval permission choices", () => {
  assert.equal(enablesAlwaysApprove({
    optionId: "always-approve",
    name: "Always approve",
    kind: "allow_always",
  }), true);
  assert.equal(enablesAlwaysApprove({
    optionId: "allow-once",
    name: "Allow once",
    kind: "allow_once",
  }), false);
});
