import type { WorkspaceFileEntry } from "../host/types";

export type ExplorerIconName =
  | "chevron"
  | "code"
  | "eye"
  | "eye-off"
  | "file"
  | "folder"
  | "folder-open"
  | "image"
  | "link"
  | "open"
  | "paperclip"
  | "settings";

export function ExplorerIcon({ name, size = 15 }: { name: ExplorerIconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {name === "chevron" && <path d="m9 6 6 6-6 6" />}
      {name === "code" && <><path d="m9 8-4 4 4 4" /><path d="m15 8 4 4-4 4" /></>}
      {name === "eye" && <><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></>}
      {name === "eye-off" && <><path d="m4 4 16 16" /><path d="M10.6 6.2A9 9 0 0 1 12 6c6.1 0 9.5 6 9.5 6a13 13 0 0 1-2.1 2.8M6.2 7.2C3.8 9 2.5 12 2.5 12s3.4 6 9.5 6a9 9 0 0 0 3.1-.5" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>}
      {name === "file" && <><path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v5h5" /></>}
      {name === "folder" && <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />}
      {name === "folder-open" && <><path d="M3 9V7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v1" /><path d="m3 10 2 9h14l2-9Z" /></>}
      {name === "image" && <><rect x="4" y="4" width="16" height="16" rx="2" /><circle cx="9" cy="9" r="1.5" /><path d="m5 17 4-4 3 3 2-2 5 4" /></>}
      {name === "link" && <><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1" /></>}
      {name === "open" && <><path d="M14 4h6v6" /><path d="m20 4-9 9" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></>}
      {name === "paperclip" && <path d="m20 11.5-8.6 8.6a5 5 0 0 1-7-7l9.3-9.3a3.5 3.5 0 1 1 5 5l-8.7 8.7a2 2 0 0 1-2.8-2.8l8-8" />}
      {name === "settings" && <><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>}
    </svg>
  );
}

export function fileVisualKind(entry: WorkspaceFileEntry) {
  if (entry.kind === "directory") return "folder";
  if (entry.kind === "symlink") return "link";
  const extension = entry.name.split(".").pop()?.toLowerCase() ?? "";
  if (["avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"].includes(extension)) return "image";
  if (["c", "cpp", "css", "go", "html", "java", "js", "jsx", "json", "md", "py", "rs", "sh", "sql", "toml", "ts", "tsx", "vue", "yaml", "yml"].includes(extension)) return "code";
  if (["env", "ini", "lock", "properties", "xml"].includes(extension) || entry.name.startsWith(".")) return "settings";
  return "file";
}

export function fileIconName(entry: WorkspaceFileEntry, expanded: boolean): ExplorerIconName {
  const visualKind = fileVisualKind(entry);
  if (visualKind === "folder") return expanded ? "folder-open" : "folder";
  return visualKind;
}

export function parentPath(path: string) {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}


export function formatWorkspaceFileSize(bytes: number | null) {
  if (bytes === null) return "";
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
}
