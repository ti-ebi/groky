export type OnboardingStage =
  | "checking"
  | "missingCli"
  | "needsAuth"
  | "ready"
  | "connecting"
  | "connected"
  | "error"
  | "webOnly";

export interface AccountProfile {
  displayName: string | null;
  email: string | null;
}

export interface OnboardingStatus {
  stage: Exclude<OnboardingStage, "checking" | "connecting" | "webOnly">;
  cliVersion: string | null;
  suggestedWorkspace: string | null;
  message: string | null;
  accountProfile: AccountProfile | null;
}

export interface PersistedSessionSummary {
  sessionId: string;
  title: string;
  workspace: string | null;
  updatedAt: number;
  archived: boolean;
  unread: boolean;
}

export interface PersistedWorkspaceSummary {
  path: string;
}

export type SessionHistoryAction = "archive" | "restore" | "delete";

export interface AppUpdateInfo {
  currentVersion: string;
  version: string;
  body: string | null;
  date: string | null;
}

export interface AppUpdateProgress {
  stage: "downloading" | "downloaded" | "installing";
  downloaded: number;
  total: number | null;
}

export interface ConnectionEvent {
  status: "connected" | "disconnected";
  message?: string | null;
  sessionIds?: string[];
}

export interface DeviceAuthCodeEvent {
  code: string;
}

export interface TerminalInfo {
  terminalId: string;
  workingDirectory: string;
  shell: string;
}

export interface TerminalOutputEvent {
  terminalId: string;
  data: number[];
}

export interface TerminalExitEvent {
  terminalId: string;
  exitCode: number | null;
  signal: string | null;
}

export type WorkspaceFileKind = "directory" | "file" | "symlink";
export type WorkspacePreviewKind = "font" | "image" | "pdf" | "text" | "unsupported";

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  kind: WorkspaceFileKind;
  size: number | null;
  modifiedAt: number | null;
  hidden: boolean;
}

export interface WorkspaceDirectoryListing {
  path: string;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
}

export interface WorkspaceChangedEvent {
  sessionId: string;
  paths: string[];
}

export interface WorkspaceFilePreview {
  path: string;
  name: string;
  kind: WorkspacePreviewKind;
  mimeType: string | null;
  size: number;
  content: string | null;
  dataUrl: string | null;
  truncated: boolean;
}

export interface WorkspaceFileAttachment {
  path: string;
  name: string;
  size: number;
  mimeType?: string | null;
}
