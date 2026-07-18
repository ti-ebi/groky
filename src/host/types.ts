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
