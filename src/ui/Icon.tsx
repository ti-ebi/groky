import type { ReactNode } from "react";

export type IconName =
  | "archive"
  | "arrow-right"
  | "arrow-down"
  | "arrow-up"
  | "check"
  | "chevron-down"
  | "compose"
  | "copy"
  | "dots"
  | "download"
  | "external-link"
  | "folder"
  | "folder-x"
  | "folder-open"
  | "file-plan"
  | "gauge"
  | "logout"
  | "monitor"
  | "moon"
  | "panel"
  | "paperclip"
  | "plus"
  | "refresh"
  | "search"
  | "shield"
  | "sliders"
  | "standalone"
  | "stop"
  | "sun"
  | "terminal"
  | "triangle-alert"
  | "trash"
  | "x";

const ICON_PATHS: Record<IconName, ReactNode> = {
  archive: <><path d="M4 7h16" /><path d="M5 7v12h14V7" /><path d="M3 4h18v3H3Z" /><path d="M9 11h6" /></>,
  "arrow-right": <><path d="m9 18 6-6-6-6" /><path d="M5 12h10" /></>,
  "arrow-down": <><path d="m6 9 6 6 6-6" /><path d="M12 5v10" /></>,
  "arrow-up": <><path d="m18 15-6-6-6 6" /><path d="M12 9v10" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  "chevron-down": <path d="m8 10 4 4 4-4" />,
  compose: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L9 17l-4 1 1-4Z" /></>,
  copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  dots: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
  download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" /></>,
  "external-link": <><path d="M14 5h5v5" /><path d="m19 5-8 8" /><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  "folder-x": <><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="m10 11 4 4m0-4-4 4" /></>,
  "folder-open": <><path d="M3 9V7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v1" /><path d="m3 10 2 9h14l2-9Z" /></>,
  "file-plan": <><path d="M6 3h8l4 4v14H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M14 3v5h5M8 12h7M8 16h5" /></>,
  gauge: <><path d="M5.6 18a8 8 0 1 1 12.8 0" /><path d="m12 14 4-4" /><path d="M8 18h8" /></>,
  logout: <><path d="M10 5H5v14h5" /><path d="M14 8l4 4-4 4M8 12h10" /></>,
  monitor: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  moon: <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" />,
  panel: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M15 4v16" /></>,
  paperclip: <path d="m20.5 11.5-8.9 8.9a5 5 0 0 1-7.1-7.1l9.6-9.6a3.5 3.5 0 1 1 5 5l-9.6 9.6a2 2 0 0 1-2.8-2.8l8.9-8.9" />,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  refresh: <><path d="M20 6v5h-5" /><path d="M4 18v-5h5" /><path d="M18 9a7 7 0 0 0-12-2L4 11M6 15a7 7 0 0 0 12 2l2-4" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  shield: <path d="M12 3 20 6v6c0 4.7-3.1 7.5-8 9-4.9-1.5-8-4.3-8-9V6Z" />,
  sliders: <><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>,
  standalone: <><path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" /><circle cx="8" cy="11" r="0.8" fill="currentColor" stroke="none" /><circle cx="12" cy="11" r="0.8" fill="currentColor" stroke="none" /><circle cx="16" cy="11" r="0.8" fill="currentColor" stroke="none" /></>,
  stop: <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />,
  sun: <><circle cx="12" cy="12" r="3.5" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3M13 15h4" /></>,
  "triangle-alert": <><path d="M10.3 4.2 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4" /><circle cx="12" cy="16.5" r="0.8" fill="currentColor" stroke="none" /></>,
  trash: <><path d="M4 7h16" /><path d="m9 7 .5-3h5l.5 3" /><path d="m6 7 1 13h10l1-13" /><path d="M10 11v5M14 11v5" /></>,
  x: <><path d="m7 7 10 10M17 7 7 17" /></>,
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}
