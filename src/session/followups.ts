import { selectModelInState, selectReasoningInState } from "./models.ts";
import type {
  FollowUpBehavior,
  PendingSessionSettings,
  QueuedPrompt,
  SessionModelState,
} from "./types.ts";

export const FOLLOW_UP_BEHAVIOR_STORAGE_KEY = "groky.followUpBehavior";

export function normalizeFollowUpBehavior(value: unknown): FollowUpBehavior {
  return value === "steer" ? "steer" : "queue";
}

export function moveQueuedPrompt(
  prompts: QueuedPrompt[],
  promptId: string,
  direction: -1 | 1,
) {
  const index = prompts.findIndex((prompt) => prompt.id === promptId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= prompts.length) return prompts;

  const next = [...prompts];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function editQueuedPrompt(
  prompts: QueuedPrompt[],
  promptId: string,
  text: string,
) {
  const normalized = text.trim();
  const prompt = prompts.find((item) => item.id === promptId);
  if (!prompt || (!normalized && prompt.attachments.length === 0)) return prompts;
  return prompts.map((prompt) => prompt.id === promptId
    ? { ...prompt, text: normalized }
    : prompt);
}

export function reserveQueuedPrompt(
  prompts: QueuedPrompt[],
  promptId: string,
) {
  const index = prompts.findIndex((prompt) => prompt.id === promptId);
  if (index < 0) return null;
  return {
    prompt: prompts[index],
    index,
    remaining: prompts.filter((prompt) => prompt.id !== promptId),
  };
}

export function restoreQueuedPrompt(
  prompts: QueuedPrompt[],
  prompt: QueuedPrompt,
  index: number,
) {
  if (prompts.some((item) => item.id === prompt.id)) return prompts;
  const next = [...prompts];
  next.splice(Math.min(Math.max(index, 0), next.length), 0, prompt);
  return next;
}

export function modelsWithPendingSettings(
  models: SessionModelState | null,
  pending: PendingSessionSettings | null,
) {
  if (!models || !pending) return models;
  let next = models;
  if (pending.modelId) next = selectModelInState(next, pending.modelId);
  if (pending.reasoningEffort) {
    next = selectReasoningInState(next, pending.reasoningEffort);
  }
  return next;
}

export function hasPendingSettings(pending: PendingSessionSettings | null) {
  return Boolean(
    pending?.approvalMode
    || pending?.modelId
    || pending?.reasoningEffort,
  );
}
