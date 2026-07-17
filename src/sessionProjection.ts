import {
  finishTiming,
  startTiming,
  type EventTiming,
} from "./timing.ts";
import type {
  AvailableCommand,
  ConversationMessage,
  ConversationState,
  ConversationTurnPreview,
  PermissionDecision,
  PermissionRequest,
  PlanEntry,
  SessionConfigOption,
  SessionUpdate,
  SessionUsage,
  StopReason,
  ToolActivity,
  ToolStatus,
  TurnTimelineItem,
} from "./sessionTypes.ts";

export function makeMessageId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function finishThought(message: ConversationMessage, endedAt: number) {
  const timeline = message.timeline?.flatMap((item) => {
    if (item.kind !== "thought" || !item.open) return [item];
    if (!item.text.trim()) return [];
    return [{
      ...item,
      open: false,
      ...finishTiming(item, endedAt),
    }];
  });
  return {
    ...message,
    timeline,
  };
}

export function addFallbackThought(message: ConversationMessage, thought: string) {
  if (!thought || message.timeline?.some((item) => item.kind === "thought")) return message;
  return {
    ...message,
    timeline: [
      { id: makeMessageId("thought"), kind: "thought" as const, text: thought, open: false },
      ...(message.timeline ?? []),
    ],
  };
}

export function reconcileFallbackResponse(message: ConversationMessage, text: string) {
  const resolvedText = text || message.text;
  if (!resolvedText) return message;

  const timeline = [...(message.timeline ?? [])];
  const responseIndexes = timeline.flatMap((item, index) => item.kind === "response" ? [index] : []);
  if (responseIndexes.length === 0) {
    timeline.push({ id: makeMessageId("response"), kind: "response", text: resolvedText });
  } else if (resolvedText.startsWith(message.text) && resolvedText.length > message.text.length) {
    const index = responseIndexes[responseIndexes.length - 1];
    const response = timeline[index];
    if (response.kind === "response") {
      timeline[index] = { ...response, text: response.text + resolvedText.slice(message.text.length) };
    }
  }
  return { ...message, text: resolvedText, timeline };
}

export function isActiveToolStatus(status: ToolStatus) {
  return status === "pending" || status === "in_progress";
}

function finishActiveTimelineTools(
  timeline: TurnTimelineItem[] | undefined,
  endedAt: number,
  status: Extract<ToolStatus, "completed" | "failed" | "cancelled">,
) {
  return timeline?.map((item) => item.kind === "tool"
    ? {
        ...item,
        tool: isActiveToolStatus(item.tool.status)
          ? { ...item.tool, ...finishTiming(item.tool, endedAt), status }
          : item.tool,
      }
    : item);
}

export function terminalToolStatus(state: ConversationState) {
  if (state === "complete") return "completed" as const;
  if (state === "error") return "failed" as const;
  return "cancelled" as const;
}

export function finishRun(
  message: ConversationMessage,
  endedAt: number,
  unfinishedToolStatus: Extract<ToolStatus, "completed" | "failed" | "cancelled"> = "completed",
) {
  const finished = finishThought(message, endedAt);
  return {
    ...finished,
    timeline: finishActiveTimelineTools(finished.timeline, endedAt, unfinishedToolStatus),
    elapsedMs: message.startedAt === undefined ? undefined : Math.max(0, endedAt - message.startedAt),
  };
}

export function stateFromStopReason(stopReason: StopReason): ConversationState {
  switch (stopReason) {
    case "end_turn":
      return "complete";
    case "cancelled":
      return "cancelled";
    case "refusal":
      return "refused";
    case "max_tokens":
    case "max_turn_requests":
      return "limited";
    default:
      return "error";
  }
}

function toolTimingForUpdate(
  existing: ToolActivity | undefined,
  status: ToolStatus,
  now: number,
  trackTiming: boolean,
): EventTiming {
  const existingTiming: EventTiming = {
    startedAt: existing?.startedAt,
    endedAt: existing?.endedAt,
    elapsedMs: existing?.elapsedMs,
  };
  if (isActiveToolStatus(status)) {
    if (existing && isActiveToolStatus(existing.status)) return existingTiming;
    return trackTiming ? startTiming(now) : {};
  }
  if (existing && isActiveToolStatus(existing.status)) return finishTiming(existingTiming, now);
  return existingTiming;
}

export function applySessionUpdateToMessage(
  message: ConversationMessage,
  update: SessionUpdate,
  now: number,
): ConversationMessage {
  switch (update.kind) {
    case "agent_message_chunk": {
      const finished = finishThought(message, now);
      const timeline = [...(finished.timeline ?? [])];
      const last = timeline[timeline.length - 1];
      if (last?.kind === "response") {
        timeline[timeline.length - 1] = { ...last, text: last.text + update.text };
      } else if (update.text) {
        timeline.push({ id: makeMessageId("response"), kind: "response", text: update.text });
      }
      return { ...finished, text: message.text + update.text, timeline };
    }
    case "agent_thought_chunk": {
      const timeline = [...(message.timeline ?? [])];
      const last = timeline[timeline.length - 1];
      if (last?.kind === "thought" && last.open) {
        timeline[timeline.length - 1] = { ...last, text: last.text + update.text };
      } else {
        timeline.push({
          id: makeMessageId("thought"),
          kind: "thought",
          text: update.text,
          open: true,
          startedAt: message.state === "streaming" ? now : undefined,
        });
      }
      return {
        ...message,
        timeline,
      };
    }
    case "tool_call":
    case "tool_call_update": {
      const finished = finishThought(message, now);
      const timeline = [...(finished.timeline ?? [])];
      const toolIndex = timeline.findIndex((item) => item.kind === "tool" && item.tool.id === update.toolCallId);
      const existingItem = toolIndex >= 0 ? timeline[toolIndex] : undefined;
      const existing = existingItem?.kind === "tool" ? existingItem.tool : undefined;
      const status = update.status ?? existing?.status ?? "in_progress";
      const nextTool: ToolActivity = {
        id: update.toolCallId,
        title: update.title ?? existing?.title ?? "Working with a local tool",
        kind: update.toolKind ?? existing?.kind ?? undefined,
        status,
        locations: update.locations ?? existing?.locations ?? [],
        ...toolTimingForUpdate(existing, status, now, message.state === "streaming"),
      };
      if (toolIndex >= 0 && existingItem?.kind === "tool") {
        timeline[toolIndex] = { ...existingItem, tool: nextTool };
      } else {
        timeline.push({ id: makeMessageId("tool"), kind: "tool", tool: nextTool });
      }
      return { ...finished, timeline };
    }
    case "turn_completed": {
      if (update.stopReason === "unknown") {
        return {
          ...finishThought(message, now),
          metrics: update.metrics ?? message.metrics,
        };
      }
      const state = stateFromStopReason(update.stopReason);
      return {
        ...finishRun(message, now, terminalToolStatus(state)),
        state,
        stopReason: update.stopReason,
        metrics: update.metrics ?? message.metrics,
        error: state === "error" ? "Grok Build ended the turn for an unknown reason." : message.error,
      };
    }
    case "permission_requested": {
      const finished = finishThought(message, now);
      if (finished.timeline?.some((item) => item.kind === "permission" && item.requestId === update.requestId)) {
        return finished;
      }
      return {
        ...finished,
        timeline: [
          ...(finished.timeline ?? []),
          {
            id: makeMessageId("permission"),
            kind: "permission",
            requestId: update.requestId,
            toolCallId: update.toolCallId,
            title: update.title,
            ...(message.state === "streaming" ? startTiming(now) : {}),
          },
        ],
      };
    }
    case "permission_decision": {
      const finished = finishThought(message, now);
      const timeline = [...(finished.timeline ?? [])];
      const decision: PermissionDecision = {
        requestId: update.requestId,
        toolCallId: update.toolCallId,
        title: update.title,
        label: update.label,
        outcome: update.outcome,
      };
      const index = timeline.findIndex((item) => item.kind === "permission" && item.requestId === update.requestId);
      if (index >= 0) {
        const permission = timeline[index];
        if (permission.kind === "permission") {
          timeline[index] = { ...permission, ...finishTiming(permission, now), decision };
        }
      } else {
        timeline.push({
          id: makeMessageId("permission"),
          kind: "permission",
          requestId: update.requestId,
          toolCallId: update.toolCallId,
          title: update.title,
          decision,
        });
      }
      return { ...finished, timeline };
    }
    default:
      return message;
  }
}

export interface SessionReplayProjection {
  messages: ConversationMessage[];
  availableCommands: AvailableCommand[] | null;
  currentModeId: string | null;
  configOptions: SessionConfigOption[];
  usage: SessionUsage | null;
  title: string | null;
  updatedAt: number | null;
  permissions: PermissionRequest[];
  plan: PlanEntry[];
}

export function sessionReplayProjection(
  sessionId: string,
  updates: SessionUpdate[],
  now: () => number = Date.now,
): SessionReplayProjection {
  const messages: ConversationMessage[] = [];
  let availableCommands: AvailableCommand[] | null = null;
  let currentModeId: string | null = null;
  let configOptions: SessionConfigOption[] = [];
  let usage: SessionUsage | null = null;
  let title: string | null = null;
  let updatedAt: number | null = null;
  let permissions: PermissionRequest[] = [];
  let plan: PlanEntry[] = [];
  const currentAssistant = () => {
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") return last;
    const assistant: ConversationMessage = {
      id: makeMessageId("replayed-assistant"),
      role: "assistant",
      text: "",
      state: "historical",
    };
    messages.push(assistant);
    return assistant;
  };

  updates.filter((update) => update.sessionId === sessionId).forEach((update) => {
    if (update.kind === "user_message_chunk") {
      const last = messages[messages.length - 1];
      if (last?.role === "user") {
        last.text += update.text ?? "";
        last.attachments = [...(last.attachments ?? []), ...(update.attachments ?? [])];
      } else {
        messages.push({
          id: makeMessageId("replayed-user"),
          role: "user",
          text: update.text ?? "",
          attachments: update.attachments ?? [],
        });
      }
      return;
    }

    if (update.kind === "available_commands_update") {
      availableCommands = update.availableCommands;
      return;
    }
    if (update.kind === "current_mode_update") {
      currentModeId = update.currentModeId;
      return;
    }
    if (update.kind === "config_option_update") {
      configOptions = update.configOptions;
      return;
    }
    if (update.kind === "usage_update") {
      usage = { used: update.used, size: update.size, cost: update.cost };
      return;
    }
    if (update.kind === "plan") {
      plan = update.entries;
      return;
    }
    if (update.kind === "session_info_update") {
      if (update.title) title = update.title;
      if (update.updatedAt) {
        const parsed = Date.parse(update.updatedAt);
        if (Number.isFinite(parsed)) updatedAt = parsed;
      }
      return;
    }
    if (update.kind === "permission_requested") {
      const permission = {
        requestId: update.requestId,
        sessionId: update.sessionId,
        toolCallId: update.toolCallId,
        title: update.title,
        toolKind: update.toolKind,
        options: update.options,
      };
      permissions = [
        ...permissions.filter((entry) => entry.requestId !== permission.requestId),
        permission,
      ];
      const assistant = currentAssistant();
      Object.assign(assistant, applySessionUpdateToMessage(assistant, update, now()));
      return;
    }
    if (update.kind === "permission_decision") {
      permissions = permissions.filter((entry) => entry.requestId !== update.requestId);
      const assistant = currentAssistant();
      Object.assign(assistant, applySessionUpdateToMessage(assistant, update, now()));
      return;
    }

    const assistant = currentAssistant();
    Object.assign(assistant, applySessionUpdateToMessage(assistant, update, now()));
  });

  return { messages, availableCommands, currentModeId, configOptions, usage, title, updatedAt, permissions, plan };
}

function previewText(text: string, limit: number) {
  const normalized = text.trim().replace(/\s+/g, " ");
  const characters = Array.from(normalized);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : normalized;
}

export function conversationTurnPreviews(messages: ConversationMessage[]) {
  const turns: ConversationTurnPreview[] = [];

  messages.forEach((message) => {
    if (message.role === "user") {
      const attachmentNames = message.attachments?.map((attachment) => attachment.name).join(", ") ?? "";
      turns.push({
        id: message.id,
        request: previewText(message.text, 96) || attachmentNames || "Untitled request",
        response: "Waiting for Grok's response…",
      });
      return;
    }

    const turn = turns[turns.length - 1];
    if (!turn) return;

    const response = previewText(message.text, 240);
    if (response) {
      turn.response = response;
    } else if (message.state === "error") {
      turn.response = "This turn failed before a response was returned.";
    } else if (message.state === "cancelled") {
      turn.response = "This turn was cancelled before a response was returned.";
    } else if (message.state !== "streaming") {
      turn.response = "No response text was returned for this turn.";
    }
  });

  return turns;
}
