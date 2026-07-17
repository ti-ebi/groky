import type {
  ApprovalMode,
  PermissionOption,
  SessionModelState,
} from "./sessionTypes.ts";

export interface ApprovalModeOption {
  id: ApprovalMode;
  label: string;
  shortDescription: string;
  description: string;
  glyph: string;
  tag?: string;
}

export const APPROVAL_MODES: ApprovalModeOption[] = [
  {
    id: "ask",
    label: "Ask",
    shortDescription: "Review actions",
    description: "Ask before actions that are not already allowed.",
    glyph: "?",
    tag: "Recommended",
  },
  {
    id: "alwaysApprove",
    label: "Always approve",
    shortDescription: "Approval prompts skipped",
    description: "Skip prompts unless a policy rule still requires approval.",
    glyph: "!",
  },
];

export const approvalModeOption = (mode: ApprovalMode) =>
  APPROVAL_MODES.find((option) => option.id === mode) ?? APPROVAL_MODES[0];

export function currentModel(models: SessionModelState | null) {
  if (!models) return null;
  return models.availableModels.find((model) => model.modelId === models.currentModelId) ?? null;
}

export function selectModelInState(models: SessionModelState, modelId: string): SessionModelState {
  return {
    ...models,
    currentModelId: modelId,
  };
}

export function selectReasoningInState(
  models: SessionModelState,
  reasoningEffort: string,
): SessionModelState {
  return {
    ...models,
    availableModels: models.availableModels.map((model) =>
      model.modelId === models.currentModelId && model.metadata
        ? {
            ...model,
            metadata: {
              ...model.metadata,
              reasoningEffort,
            },
          }
        : model
    ),
  };
}

export function enablesAlwaysApprove(option: PermissionOption | undefined) {
  if (!option || option.kind !== "allow_always") return false;

  const id = option.optionId.toLowerCase().replace(/_/g, "-");
  const name = option.name.toLowerCase();
  return id.includes("always-approve")
    || name.includes("always approve")
    || name.includes("all sessions")
    || name.includes("all tool");
}
