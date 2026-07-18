import type { SessionModelState } from "./types";

export function currentModel(models: SessionModelState | null) {
  if (!models) return null;
  return models.availableModels.find((model) => model.modelId === models.currentModelId) ?? null;
}

export function selectModelInState(
  models: SessionModelState,
  modelId: string,
): SessionModelState {
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
