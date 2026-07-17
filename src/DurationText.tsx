import { useEffect, useState } from "react";
import { formatDuration } from "./format";
import { elapsedForTiming, type EventTiming } from "./timing";

function useTimingElapsed(timing: EventTiming, active: boolean) {
  const live = active && timing.startedAt !== undefined && timing.endedAt === undefined;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live, timing.startedAt]);

  if (!live && timing.startedAt !== undefined && timing.endedAt === undefined && timing.elapsedMs === undefined) {
    return { elapsedMs: undefined, live: false };
  }
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
