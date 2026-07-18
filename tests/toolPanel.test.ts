import assert from "node:assert/strict";
import test from "node:test";
import {
  appendToolPanelAttachment,
  createToolPanelState,
  mergeToolPanelAttachments,
  removeToolPanelStateKeys,
  removeUnavailableFileTabs,
  transferToolPanelState,
  updateToolPanelStateMap,
} from "../src/session/toolPanel.ts";

function ids(...values: string[]) {
  let index = 0;
  return () => values[index++] ?? `tab-${index}`;
}

test("creates workspace tool tabs with Files selected", () => {
  const state = createToolPanelState({
    workspace: "/work/groky",
    workingDirectory: "/work/groky",
    width: 520,
  }, ids("files", "terminal", "panel"));

  assert.deepEqual(state, {
    mountKey: "panel",
    open: false,
    width: 520,
    tabs: [
      { id: "files", type: "files" },
      { id: "terminal", type: "terminal", workingDirectory: "/work/groky" },
    ],
    activeTabId: "files",
  });
});

test("creates standalone tool panels without a Files tab", () => {
  const state = createToolPanelState({
    workspace: null,
    workingDirectory: "/tmp",
    width: 480,
  }, ids("terminal", "panel"));

  assert.deepEqual(state, {
    mountKey: "panel",
    open: false,
    width: 480,
    tabs: [{ id: "terminal", type: "terminal", workingDirectory: "/tmp" }],
    activeTabId: "terminal",
  });
});

test("removes an active Files tab when its session has no workspace", () => {
  const state = createToolPanelState({
    workspace: "/work/groky",
    workingDirectory: "/work/groky",
    width: 480,
  }, ids("files", "terminal", "panel"));

  assert.deepEqual(removeUnavailableFileTabs(state, null), {
    ...state,
    tabs: [{ id: "terminal", type: "terminal", workingDirectory: "/work/groky" }],
    activeTabId: "terminal",
  });
});

test("updates panel state without leaking it into another session", () => {
  const createState = () => createToolPanelState({
    workspace: null,
    workingDirectory: null,
    width: 480,
  }, ids("terminal", "panel"));
  const first = updateToolPanelStateMap({}, "session-a", createState, (current) => ({
    ...current,
    open: true,
    width: 620,
  }));
  const second = updateToolPanelStateMap(first, "session-b", createState, (current) => ({
    ...current,
    open: false,
  }));

  assert.equal(second["session-a"]?.open, true);
  assert.equal(second["session-a"]?.width, 620);
  assert.equal(second["session-b"]?.open, false);
  assert.equal(second["session-b"]?.width, 480);
});

test("transfers a pending panel to its created session", () => {
  const pending = createToolPanelState({
    workspace: "/work/groky",
    workingDirectory: "/work/groky",
    width: 520,
  }, ids("files", "terminal", "panel"));
  const transferred = transferToolPanelState({ pending }, "pending", "session-a");

  assert.equal(transferred.pending, undefined);
  assert.equal(transferred["session-a"], pending);
});

test("removes panel state for deleted sessions", () => {
  const session = createToolPanelState({
    workspace: "/work/groky",
    workingDirectory: "/work/groky",
    width: 520,
  }, ids("files", "terminal", "panel"));

  const transferred = { "session-a": session };
  assert.deepEqual(removeToolPanelStateKeys(transferred, ["session-a"]), {});
});

test("drops a deferred attachment after switching sessions", async () => {
  let activeKey = "session-a";
  let resolveAttachment: ((attachment: { path: string }) => void) | undefined;
  const inspected = new Promise<{ path: string }>((resolve) => {
    resolveAttachment = resolve;
  });
  const existing = [{ path: "/work/a.txt" }];
  const attachmentRequest = (async () => {
    const attachment = await inspected;
    return appendToolPanelAttachment(
      "session-a",
      activeKey,
      existing,
      attachment,
      5,
    );
  })();

  activeKey = "session-b";
  resolveAttachment?.({ path: "/work/b.txt" });

  assert.deepEqual(await attachmentRequest, {
    attachments: existing,
    result: "stale",
  });
});

test("merges inspected files into the latest attachments", () => {
  const latest = [
    { path: "/work/a.txt" },
    { path: "/work/concurrent.txt" },
  ];

  assert.deepEqual(mergeToolPanelAttachments(
    "session-a",
    "session-a",
    latest,
    [
      { path: "/work/a.txt" },
      { path: "/work/selected.txt" },
    ],
    5,
  ), {
    attachments: [
      ...latest,
      { path: "/work/selected.txt" },
    ],
    result: "added",
  });
});

test("does not restore attachments removed while inspection is pending", () => {
  assert.deepEqual(mergeToolPanelAttachments(
    "session-a",
    "session-a",
    [],
    [{ path: "/work/selected.txt" }],
    5,
  ), {
    attachments: [{ path: "/work/selected.txt" }],
    result: "added",
  });
});

test("keeps the latest attachments unchanged when a merge reaches the limit", () => {
  const latest = [
    { path: "/work/a.txt" },
    { path: "/work/concurrent.txt" },
  ];

  assert.deepEqual(mergeToolPanelAttachments(
    "session-a",
    "session-a",
    latest,
    [
      { path: "/work/a.txt" },
      { path: "/work/selected.txt" },
    ],
    2,
  ), {
    attachments: latest,
    result: "limit",
  });
});
