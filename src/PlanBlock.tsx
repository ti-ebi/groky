import { useEffect, useId, useState } from "react";
import { Icon } from "./Icon";
import type { PlanEntry } from "./sessionTypes";

export function PlanBlock({ entries, active }: { entries: PlanEntry[]; active: boolean }) {
  const [open, setOpen] = useState(active);
  const contentId = useId();
  const current = entries.find((entry) => entry.status === "in_progress")
    ?? entries.find((entry) => entry.status === "pending");
  const completed = entries.filter((entry) => entry.status === "completed").length;
  const summary = active && current
    ? current.content
    : `${completed}/${entries.length} plan steps complete`;

  useEffect(() => {
    if (active) setOpen(true);
    else if (completed === entries.length) setOpen(false);
  }, [active, completed, entries.length]);

  return (
    <div className="progress-disclosure plan-disclosure" data-open={open}>
      <button type="button" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen((value) => !value)}>
        <span className="progress-disclosure-label"><Icon name="chevron-down" size={13} /> PLAN</span>
        <span className="progress-disclosure-summary">{summary}</span>
      </button>
      <div className="progress-disclosure-content" id={contentId} aria-hidden={!open}>
        <div>
          {entries.map((entry, index) => (
            <div className="plan-row" key={`${entry.content}-${index}`}>
              <i className={entry.status} />
              <span>{entry.content}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
