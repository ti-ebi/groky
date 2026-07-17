import assert from "node:assert/strict";
import test from "node:test";
import {
  combineTimings,
  elapsedForTiming,
  finishTiming,
  startTiming,
} from "../src/timing.ts";

test("tracks a live duration and freezes it when the event finishes", () => {
  const running = startTiming(1_000);
  assert.equal(elapsedForTiming(running, 2_250), 1_250);

  const finished = finishTiming(running, 2_750);
  assert.deepEqual(finished, {
    startedAt: 1_000,
    endedAt: 2_750,
    elapsedMs: 1_750,
  });
  assert.equal(elapsedForTiming(finished, 10_000), 1_750);
});

test("uses wall-clock time for a completed event group", () => {
  const group = combineTimings([
    { startedAt: 1_000, endedAt: 2_000, elapsedMs: 1_000 },
    { startedAt: 1_500, endedAt: 3_000, elapsedMs: 1_500 },
  ]);

  assert.deepEqual(group, {
    startedAt: 1_000,
    endedAt: 3_000,
    elapsedMs: 2_000,
  });
});

test("keeps a group timer live while any timed event is still running", () => {
  const group = combineTimings([
    { startedAt: 1_000, endedAt: 2_000, elapsedMs: 1_000 },
    { startedAt: 2_500 },
  ]);

  assert.deepEqual(group, { startedAt: 1_000 });
  assert.equal(elapsedForTiming(group, 4_000), 3_000);
});

test("does not invent timing for replayed events without timestamps", () => {
  const group = combineTimings([{}, { elapsedMs: undefined }]);
  assert.deepEqual(group, {});
  assert.equal(elapsedForTiming(group, 4_000), undefined);
});

test("never leaks unrelated event fields from the timing helper", () => {
  const event = { startedAt: 1_000, open: true, title: "Thinking" };
  assert.deepEqual(finishTiming(event, 2_000), {
    startedAt: 1_000,
    endedAt: 2_000,
    elapsedMs: 1_000,
  });
});
