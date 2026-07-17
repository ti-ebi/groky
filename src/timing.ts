export interface EventTiming {
  startedAt?: number;
  endedAt?: number;
  elapsedMs?: number;
}

export function startTiming(startedAt: number): EventTiming {
  return { startedAt };
}

export function finishTiming(timing: EventTiming, endedAt: number): EventTiming {
  if (timing.startedAt === undefined) {
    return {
      startedAt: timing.startedAt,
      endedAt: timing.endedAt,
      elapsedMs: timing.elapsedMs,
    };
  }

  const resolvedEndedAt = timing.endedAt ?? Math.max(timing.startedAt, endedAt);
  return {
    startedAt: timing.startedAt,
    endedAt: resolvedEndedAt,
    elapsedMs: timing.elapsedMs ?? resolvedEndedAt - timing.startedAt,
  };
}

export function elapsedForTiming(timing: EventTiming, now: number): number | undefined {
  if (timing.elapsedMs !== undefined && timing.endedAt !== undefined) {
    return Math.max(0, timing.elapsedMs);
  }
  if (timing.startedAt === undefined) return timing.elapsedMs;
  return Math.max(0, (timing.endedAt ?? now) - timing.startedAt);
}

export function combineTimings(timings: EventTiming[]): EventTiming {
  const known = timings.filter((timing) => timing.startedAt !== undefined);
  if (known.length === 0) return {};

  const startedAt = Math.min(...known.map((timing) => timing.startedAt as number));
  if (known.some((timing) => timing.endedAt === undefined)) return { startedAt };

  const endedAt = Math.max(...known.map((timing) => timing.endedAt as number));
  return {
    startedAt,
    endedAt,
    elapsedMs: Math.max(0, endedAt - startedAt),
  };
}
