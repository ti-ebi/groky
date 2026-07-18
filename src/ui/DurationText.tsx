import { useEffect, useState } from "react";
import { elapsedForTiming, type EventTiming } from "../timing";

export function formatDuration(elapsedMs: number) {
  const safeElapsedMs = Math.max(0, elapsedMs);
  const totalSeconds = Math.floor(safeElapsedMs / 1_000);
  if (totalSeconds < 10) return `${(safeElapsedMs / 1_000).toFixed(1)}s`;
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${seconds}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

export function formatThoughtDuration(elapsedMs: number) {
  const totalSeconds = Math.max(0, elapsedMs) / 1_000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;

  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m${(totalSeconds - minutes * 60).toFixed(0)}s`;
}

function useTimingElapsed(timing: EventTiming, active: boolean) {
  const live = active && timing.startedAt !== undefined && timing.endedAt === undefined;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;

    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live, timing.startedAt]);

  const hasIncompleteHistoricalTiming = !live
    && timing.startedAt !== undefined
    && timing.endedAt === undefined
    && timing.elapsedMs === undefined;
  if (hasIncompleteHistoricalTiming) return { elapsedMs: undefined, live: false };

  return { elapsedMs: elapsedForTiming(timing, now), live };
}

export function DurationText({
  timing,
  active = false,
  className,
  label = "Elapsed time",
  prefix = "",
  formatter = formatDuration,
}: {
  timing: EventTiming;
  active?: boolean;
  className?: string;
  label?: string;
  prefix?: string;
  formatter?: (elapsedMs: number) => string;
}) {
  const { elapsedMs, live } = useTimingElapsed(timing, active);
  if (elapsedMs === undefined) return null;

  const duration = formatter(elapsedMs);

  return (
    <span
      className={["duration-text", className].filter(Boolean).join(" ")}
      role={live ? "timer" : undefined}
      aria-label={`${label}: ${duration}`}
    >
      {prefix}{duration}
    </span>
  );
}
