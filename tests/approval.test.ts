import assert from "node:assert/strict";
import test from "node:test";
import { APPROVAL_MODES, normalizeApprovalMode } from "../src/session/approval.ts";

test("exposes Grok Build modes in their standard order", () => {
  assert.deepEqual(
    APPROVAL_MODES.map((mode) => mode.id),
    ["normal", "plan", "auto", "alwaysApprove"],
  );
  assert.equal(new Set(APPROVAL_MODES.map((mode) => mode.icon)).size, APPROVAL_MODES.length);
});

test("normalizes stored modes and migrates the legacy ask value", () => {
  assert.equal(normalizeApprovalMode("normal"), "normal");
  assert.equal(normalizeApprovalMode("plan"), "plan");
  assert.equal(normalizeApprovalMode("auto"), "auto");
  assert.equal(normalizeApprovalMode("alwaysApprove"), "alwaysApprove");
  assert.equal(normalizeApprovalMode("ask"), "normal");
  assert.equal(normalizeApprovalMode(null), "normal");
});
