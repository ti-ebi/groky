import { finishTiming, startTiming, type EventTiming } from "../timing.ts";
import type {
  ConversationMessage,
  ConversationState,
  PermissionDecision,
  SessionReplayProjection,
  SessionUpdate,
  StopReason,
  ToolActivity,
  ToolStatus,
  TurnTimelineItem,
} from "./types.ts";

type MessageIdFactory = (prefix: string) => string;

interface ReplayOptions {
  createMessageId?: MessageIdFactory;
  now?: () => number;
}

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

  return { ...message, timeline };
}

export function addFallbackThought(
  message: ConversationMessage,
  thought: string,
  createMessageId: MessageIdFactory = makeMessageId,
) {
  const alreadyHasThought = message.timeline?.some((item) => item.kind === "thought");
  if (!thought || alreadyHasThought) return message;

  return {
    ...message,
    timeline: [
      { id: createMessageId("thought"), kind: "thought" as const, text: thought, open: false },
      ...(message.timeline ?? []),
    ],
  };
}

export function addSteeringMarker(
  message: ConversationMessage,
  text: string,
  now: number,
  createMessageId: MessageIdFactory = makeMessageId,
) {
  const finished = finishThought(message, now);
  return {
    ...finished,
    timeline: [
      ...(finished.timeline ?? []),
      { id: createMessageId("steer"), kind: "steer" as const, text },
    ],
  };
}

export function reconcileFallbackResponse(
  message: ConversationMessage,
  text: string,
  createMessageId: MessageIdFactory = makeMessageId,
) {
  const resolvedText = text || message.text;
  if (!resolvedText) return message;

  const timeline = [...(message.timeline ?? [])];
  const responseIndexes = timeline.flatMap((item, index) => (
    item.kind === "response" ? [index] : []
  ));
  const lastSteeringIndex = timeline.reduce((latest, item, index) => (
    item.kind === "steer" ? index : latest
  ), -1);

  if (responseIndexes.length === 0) {
    timeline.push({ id: createMessageId("response"), kind: "response", text: resolvedText });
  } else if (resolvedText.startsWith(message.text) && resolvedText.length > message.text.length) {
    const lastResponseIndex = responseIndexes[responseIndexes.length - 1];
    const lastResponse = timeline[lastResponseIndex];
    const remainingText = resolvedText.slice(message.text.length);

    if (lastResponseIndex < lastSteeringIndex) {
      timeline.push({ id: createMessageId("response"), kind: "response", text: remainingText });
    } else if (lastResponse.kind === "response") {
      timeline[lastResponseIndex] = {
        ...lastResponse,
        text: lastResponse.text + remainingText,
      };
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
  return timeline?.map((item) => {
    if (item.kind !== "tool" || !isActiveToolStatus(item.tool.status)) return item;

    return {
      ...item,
      tool: {
        ...item.tool,
        ...finishTiming(item.tool, endedAt),
        status,
      },
    };
  });
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

  if (existing && isActiveToolStatus(existing.status)) {
    return finishTiming(existingTiming, now);
  }

  return existingTiming;
}

export function applySessionUpdateToMessage(
  message: ConversationMessage,
  update: SessionUpdate,
  now: number,
  createMessageId: MessageIdFactory = makeMessageId,
): ConversationMessage {
  switch (update.kind) {
    case "agent_message_chunk": {
      const finished = finishThought(message, now);
      const timeline = [...(finished.timeline ?? [])];
      const last = timeline[timeline.length - 1];

      if (last?.kind === "response") {
        timeline[timeline.length - 1] = { ...last, text: last.text + update.text };
      } else if (update.text) {
        timeline.push({ id: createMessageId("response"), kind: "response", text: update.text });
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
          id: createMessageId("thought"),
          kind: "thought",
          text: update.text,
          open: true,
          startedAt: message.state === "streaming" ? now : undefined,
        });
      }

      return { ...message, timeline };
    }

    case "tool_call":
    case "tool_call_update": {
      const finished = finishThought(message, now);
      const timeline = [...(finished.timeline ?? [])];
      const toolIndex = timeline.findIndex((item) => (
        item.kind === "tool" && item.tool.id === update.toolCallId
      ));
      const existingItem = toolIndex >= 0 ? timeline[toolIndex] : undefined;
      const existingTool = existingItem?.kind === "tool" ? existingItem.tool : undefined;
      const status = update.status ?? existingTool?.status ?? "in_progress";
      const nextTool: ToolActivity = {
        id: update.toolCallId,
        title: update.title ?? existingTool?.title ?? "Working with a local tool",
        kind: update.toolKind ?? existingTool?.kind ?? undefined,
        status,
        locations: update.locations ?? existingTool?.locations ?? [],
        ...toolTimingForUpdate(existingTool, status, now, message.state === "streaming"),
      };

      if (toolIndex >= 0 && existingItem?.kind === "tool") {
        timeline[toolIndex] = { ...existingItem, tool: nextTool };
      } else {
        timeline.push({ id: createMessageId("tool"), kind: "tool", tool: nextTool });
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
      const permissionAlreadyExists = finished.timeline?.some((item) => (
        item.kind === "permission" && item.requestId === update.requestId
      ));
      if (permissionAlreadyExists) return finished;

      return {
        ...finished,
        timeline: [
          ...(finished.timeline ?? []),
          {
            id: createMessageId("permission"),
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
      const permissionIndex = timeline.findIndex((item) => (
        item.kind === "permission" && item.requestId === update.requestId
      ));
      const permission = permissionIndex >= 0 ? timeline[permissionIndex] : undefined;

      if (permission?.kind === "permission") {
        timeline[permissionIndex] = {
          ...permission,
          ...finishTiming(permission, now),
          decision,
        };
      } else {
        timeline.push({
          id: createMessageId("permission"),
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

function emptyReplayProjection(): SessionReplayProjection {
  return {
    messages: [],
    availableCommands: null,
    currentModeId: null,
    configOptions: [],
    usage: null,
    title: null,
    updatedAt: null,
    permissions: [],
    plan: [],
  };
}

function appendUserMessage(
  projection: SessionReplayProjection,
  update: Extract<SessionUpdate, { kind: "user_message_chunk" }>,
  createMessageId: MessageIdFactory,
) {
  const messages = projection.messages;
  const lastMessage = messages[messages.length - 1];

  if (lastMessage?.role === "user") {
    const updatedMessage = {
      ...lastMessage,
      text: lastMessage.text + update.text,
      attachments: [...(lastMessage.attachments ?? []), ...(update.attachments ?? [])],
    };

    return {
      ...projection,
      messages: [...messages.slice(0, -1), updatedMessage],
    };
  }

  return {
    ...projection,
    messages: [
      ...messages,
      {
        id: createMessageId("replayed-user"),
        role: "user" as const,
        text: update.text,
        attachments: update.attachments ?? [],
      },
    ],
  };
}

function updateCurrentAssistant(
  projection: SessionReplayProjection,
  update: SessionUpdate,
  now: number,
  createMessageId: MessageIdFactory,
) {
  const messages = projection.messages;
  const lastMessage = messages[messages.length - 1];
  const assistant = lastMessage?.role === "assistant"
    ? lastMessage
    : {
        id: createMessageId("replayed-assistant"),
        role: "assistant" as const,
        text: "",
        state: "historical" as const,
      };
  const updatedAssistant = applySessionUpdateToMessage(
    assistant,
    update,
    now,
    createMessageId,
  );

  return {
    ...projection,
    messages: lastMessage?.role === "assistant"
      ? [...messages.slice(0, -1), updatedAssistant]
      : [...messages, updatedAssistant],
  };
}

function projectReplayUpdate(
  projection: SessionReplayProjection,
  update: SessionUpdate,
  now: number,
  createMessageId: MessageIdFactory,
): SessionReplayProjection {
  switch (update.kind) {
    case "user_message_chunk":
      return appendUserMessage(projection, update, createMessageId);

    case "available_commands_update":
      return { ...projection, availableCommands: update.availableCommands };

    case "current_mode_update":
      return { ...projection, currentModeId: update.currentModeId };

    case "config_option_update":
      return { ...projection, configOptions: update.configOptions };

    case "usage_update":
      return {
        ...projection,
        usage: { used: update.used, size: update.size, cost: update.cost },
      };

    case "plan":
      return { ...projection, plan: update.entries };

    case "session_info_update": {
      const parsedUpdatedAt = update.updatedAt ? Date.parse(update.updatedAt) : Number.NaN;

      return {
        ...projection,
        title: update.title || projection.title,
        updatedAt: Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : projection.updatedAt,
      };
    }

    case "permission_requested": {
      const permission = {
        requestId: update.requestId,
        sessionId: update.sessionId,
        toolCallId: update.toolCallId,
        title: update.title,
        toolKind: update.toolKind,
        options: update.options,
      };
      const withPermission = {
        ...projection,
        permissions: [
          ...projection.permissions.filter((entry) => entry.requestId !== permission.requestId),
          permission,
        ],
      };

      return updateCurrentAssistant(withPermission, update, now, createMessageId);
    }

    case "permission_decision": {
      const withoutPermission = {
        ...projection,
        permissions: projection.permissions.filter((entry) => entry.requestId !== update.requestId),
      };

      return updateCurrentAssistant(withoutPermission, update, now, createMessageId);
    }

    default:
      return updateCurrentAssistant(projection, update, now, createMessageId);
  }
}

export function sessionReplayProjection(
  sessionId: string,
  updates: SessionUpdate[],
  options: ReplayOptions = {},
) {
  const createMessageId = options.createMessageId ?? makeMessageId;
  const now = options.now ?? Date.now;

  return updates
    .filter((update) => update.sessionId === sessionId)
    .reduce(
      (projection, update) => projectReplayUpdate(
        projection,
        update,
        now(),
        createMessageId,
      ),
      emptyReplayProjection(),
    );
}
