import assert from "node:assert/strict";
import test from "node:test";
import {
  editQueuedPrompt,
  modelsWithPendingSettings,
  moveQueuedPrompt,
  normalizeFollowUpBehavior,
  reserveQueuedPrompt,
  restoreQueuedPrompt,
} from "../src/session/followups.ts";
import type { QueuedPrompt, SessionModelState } from "../src/session/types.ts";

const prompts: QueuedPrompt[] = [
  { id: "one", text: "First", attachments: [] },
  { id: "two", text: "Second", attachments: [] },
  { id: "three", text: "Third", attachments: [] },
];

test("moves queued prompts without mutating the original order", () => {
  const moved = moveQueuedPrompt(prompts, "two", -1);
  assert.deepEqual(moved.map((prompt) => prompt.id), ["two", "one", "three"]);
  assert.deepEqual(prompts.map((prompt) => prompt.id), ["one", "two", "three"]);
  assert.equal(moveQueuedPrompt(prompts, "one", -1), prompts);
});

test("edits queued prompt text while rejecting an empty replacement", () => {
  assert.equal(editQueuedPrompt(prompts, "one", "   "), prompts);
  assert.equal(editQueuedPrompt(prompts, "two", "  Revised  ")[1].text, "Revised");

  const attachmentOnly: QueuedPrompt[] = [{
    id: "attachment",
    text: "Describe this file",
    attachments: [{ path: "/workspace/spec.pdf", name: "spec.pdf", size: 42 }],
  }];
  assert.equal(editQueuedPrompt(attachmentOnly, "attachment", "   ")[0].text, "");
});

test("reserves and restores a queued prompt at its original position", () => {
  const reserved = reserveQueuedPrompt(prompts, "two");
  assert.ok(reserved);
  assert.deepEqual(reserved.remaining.map((prompt) => prompt.id), ["one", "three"]);
  assert.deepEqual(
    restoreQueuedPrompt(reserved.remaining, reserved.prompt, reserved.index).map((prompt) => prompt.id),
    ["one", "two", "three"],
  );
  assert.equal(reserveQueuedPrompt(prompts, "missing"), null);
  assert.equal(restoreQueuedPrompt(prompts, prompts[1], 0), prompts);
});

test("defaults follow-up behavior to queue", () => {
  assert.equal(normalizeFollowUpBehavior("steer"), "steer");
  assert.equal(normalizeFollowUpBehavior("interrupt"), "queue");
  assert.equal(normalizeFollowUpBehavior(null), "queue");
});

test("projects pending model and reasoning choices for the composer", () => {
  const models: SessionModelState = {
    currentModelId: "fast",
    availableModels: [
      { modelId: "fast", name: "Fast" },
      {
        modelId: "deep",
        name: "Deep",
        metadata: { reasoningEffort: "low" },
      },
    ],
  };
  const selected = modelsWithPendingSettings(models, {
    modelId: "deep",
    reasoningEffort: "high",
  });

  assert.equal(selected?.currentModelId, "deep");
  assert.equal(selected?.availableModels[1].metadata?.reasoningEffort, "high");
  assert.equal(models.currentModelId, "fast");
});
