import assert from "node:assert/strict";
import test from "node:test";
import { compareSidebarSessions, groupSidebarSessions } from "../src/sidebar/sessionList.ts";
import type { SidebarSessionSummary } from "../src/sidebar/types.ts";

function session(
  sessionId: string,
  overrides: Partial<SidebarSessionSummary> = {},
): SidebarSessionSummary {
  return {
    sessionId,
    title: sessionId,
    workspace: null,
    running: false,
    needsAttention: false,
    updatedAt: 0,
    archived: false,
    unread: false,
    ...overrides,
  };
}

test("orders attention and unread sessions before ordinary recent activity", () => {
  const sessions = [
    session("recent", { updatedAt: 40 }),
    session("running", { running: true, updatedAt: 10 }),
    session("unread", { unread: true, updatedAt: 20 }),
    session("attention", { needsAttention: true, updatedAt: 5 }),
  ];

  assert.deepEqual(
    sessions.sort(compareSidebarSessions).map(({ sessionId }) => sessionId),
    ["attention", "unread", "running", "recent"],
  );
});

test("groups workspace sessions without losing standalone sessions", () => {
  const grouped = groupSidebarSessions([
    session("alpha-1", { workspace: "/work/alpha" }),
    session("standalone"),
    session("alpha-2", { workspace: "/work/alpha" }),
    session("beta", { workspace: "/work/beta" }),
  ]);

  assert.deepEqual(
    grouped.workspaceGroups.map(({ path, sessions }) => [
      path,
      sessions.map(({ sessionId }) => sessionId),
    ]),
    [
      ["/work/alpha", ["alpha-1", "alpha-2"]],
      ["/work/beta", ["beta"]],
    ],
  );
  assert.deepEqual(grouped.ungrouped.map(({ sessionId }) => sessionId), ["standalone"]);
});
