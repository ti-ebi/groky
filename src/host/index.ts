import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ApprovalMode,
  AvailableCommand,
  Connection,
  FileAttachment,
  LoadSessionResult,
  PermissionRequest,
  PromptResult,
  SessionModelState,
  SessionUpdate,
} from "../session/types";
import type {
  AppUpdateInfo,
  AppUpdateProgress,
  ConnectionEvent,
  DeviceAuthCodeEvent,
  OnboardingStatus,
  PersistedSessionSummary,
  PersistedWorkspaceSummary,
  SessionHistoryAction,
} from "./types";

type EventHandler<T> = (payload: T) => void;

function command<T>(name: string, payload?: Record<string, unknown>) {
  return invoke<T>(name, payload);
}

function subscribe<T>(event: string, handler: EventHandler<T>) {
  return listen<T>(event, ({ payload }) => handler(payload));
}

export const host = {
  configureNativeTitlebar: () => command<number | null>("configure_native_titlebar"),

  updates: {
    check: () => command<AppUpdateInfo | null>("check_app_update"),
    install: () => command<void>("install_app_update"),
    onProgress: (handler: EventHandler<AppUpdateProgress>) => (
      subscribe("groky://update-progress", handler)
    ),
  },

  attachments: {
    choose: () => command<FileAttachment[]>("choose_attachments"),
    inspect: (paths: string[]) => command<FileAttachment[]>("inspect_attachments", { paths }),
  },

  grok: {
    status: () => command<OnboardingStatus>("grok_status"),
    login: () => command<void>("grok_login"),
    logout: () => command<void>("grok_logout"),
    openInstallGuide: () => command<void>("open_grok_install_guide"),
    openUsage: () => command<void>("open_grok_usage"),

    connect: (options: {
      workspace: string | null;
      approvalMode: ApprovalMode;
      modelId?: string;
      reasoningEffort?: string | null;
    }) => command<Connection>("grok_connect", options),

    listCommands: (options: {
      workspace: string | null;
      approvalMode: ApprovalMode;
    }) => command<AvailableCommand[]>("grok_list_commands", options),

    listModels: (options: {
      workspace: string | null;
      approvalMode: ApprovalMode;
    }) => command<SessionModelState | null>("grok_list_models", options),

    prompt: (options: {
      sessionId: string;
      prompt: string;
      attachmentPaths: string[];
    }) => command<PromptResult>("grok_prompt", options),

    sessions: {
      list: () => command<PersistedSessionSummary[]>("grok_list_sessions"),
      load: (sessionId: string) => command<LoadSessionResult>("grok_load_session", { sessionId }),
      activate: (sessionId: string | null) => command<void>("grok_activate_session", { sessionId }),
      deactivate: (sessionId: string) => command<void>("grok_deactivate_session", { sessionId }),
      rename: (sessionId: string, title: string) => (
        command<PersistedSessionSummary>("grok_rename_session", { sessionId, title })
      ),
      mutate: (options: {
        action: SessionHistoryAction;
        sessionId?: string;
        workspace?: string;
      }) => command<PersistedSessionSummary[]>("grok_mutate_sessions", options),
      setApprovalMode: (sessionId: string, approvalMode: ApprovalMode) => (
        command<Connection>("grok_set_approval_mode", { sessionId, approvalMode })
      ),
      setModel: (sessionId: string, modelId: string) => (
        command<SessionModelState>("grok_set_model", { sessionId, modelId })
      ),
      setReasoningEffort: (sessionId: string, reasoningEffort: string) => (
        command<SessionModelState>("grok_set_reasoning_effort", { sessionId, reasoningEffort })
      ),
      cancel: (sessionId: string) => command<void>("grok_cancel", { sessionId }),
      respondToPermission: (
        sessionId: string,
        requestId: string,
        optionId: string | null,
      ) => command<void>("grok_respond_permission", { sessionId, requestId, optionId }),
    },

    workspaces: {
      choose: () => command<string | null>("choose_workspace"),
      list: () => command<PersistedWorkspaceSummary[]>("grok_list_workspaces"),
      add: (workspace: string) => (
        command<PersistedWorkspaceSummary>("grok_add_workspace", { workspace })
      ),
      remove: (workspace: string) => (
        command<PersistedWorkspaceSummary[]>("grok_remove_workspace", { workspace })
      ),
    },

    events: {
      onSessionUpdate: (handler: EventHandler<SessionUpdate>) => (
        subscribe("grok://session-update", handler)
      ),
      onPermissionRequest: (handler: EventHandler<PermissionRequest>) => (
        subscribe("grok://permission-request", handler)
      ),
      onConnection: (handler: EventHandler<ConnectionEvent>) => (
        subscribe("grok://connection", handler)
      ),
      onDeviceAuthCode: (handler: EventHandler<DeviceAuthCodeEvent>) => (
        subscribe("grok://device-auth-code", handler)
      ),
    },
  },
} as const;
