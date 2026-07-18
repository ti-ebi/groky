export interface TerminalToolTabState {
  id: string;
  type: "terminal";
  workingDirectory: string | null;
}

export interface FileToolTabState {
  id: string;
  type: "files";
}

export type ToolPanelTabState = FileToolTabState | TerminalToolTabState;

export interface ToolPanelState {
  mountKey: string;
  open: boolean;
  width: number;
  tabs: ToolPanelTabState[];
  activeTabId: string | null;
}

export type ToolPanelStateMap = Record<string, ToolPanelState>;
export type ToolPanelStateUpdate = (current: ToolPanelState) => ToolPanelState;

interface CreateToolPanelStateOptions {
  workspace: string | null;
  workingDirectory: string | null;
  width: number;
}

export function createToolPanelState(
  {
    workspace,
    workingDirectory,
    width,
  }: CreateToolPanelStateOptions,
  createId: () => string = () => crypto.randomUUID(),
): ToolPanelState {
  const tabs: ToolPanelTabState[] = [
    ...(workspace ? [{ id: createId(), type: "files" } as const] : []),
    { id: createId(), type: "terminal", workingDirectory },
  ];
  return {
    mountKey: createId(),
    open: false,
    width,
    tabs,
    activeTabId: tabs[0]?.id ?? null,
  };
}

export type ToolPanelAttachmentResult = "added" | "duplicate" | "limit" | "stale" | "disabled";

export function appendToolPanelAttachment<T extends { path: string }>(
  requestKey: string,
  activeKey: string,
  attachments: T[],
  attachment: T,
  limit: number,
): { attachments: T[]; result: ToolPanelAttachmentResult } {
  if (requestKey !== activeKey) return { attachments, result: "stale" };
  if (attachments.length >= limit) return { attachments, result: "limit" };
  if (attachments.some((current) => current.path === attachment.path)) {
    return { attachments, result: "duplicate" };
  }
  return { attachments: [...attachments, attachment], result: "added" };
}

export function mergeToolPanelAttachments<T extends { path: string }>(
  requestKey: string,
  activeKey: string,
  attachments: T[],
  incoming: T[],
  limit: number,
): { attachments: T[]; result: ToolPanelAttachmentResult } {
  if (requestKey !== activeKey) return { attachments, result: "stale" };

  let merged = attachments;
  for (const attachment of incoming) {
    if (merged.some((current) => current.path === attachment.path)) continue;
    if (merged.length >= limit) return { attachments, result: "limit" };
    merged = [...merged, attachment];
  }
  return {
    attachments: merged,
    result: merged === attachments ? "duplicate" : "added",
  };
}

export function removeUnavailableFileTabs(
  state: ToolPanelState,
  workspace: string | null,
): ToolPanelState {
  if (workspace || !state.tabs.some((tab) => tab.type === "files")) return state;

  const tabs = state.tabs.filter((tab) => tab.type !== "files");
  return {
    ...state,
    tabs,
    activeTabId: tabs.some((tab) => tab.id === state.activeTabId)
      ? state.activeTabId
      : tabs[0]?.id ?? null,
  };
}

export function updateToolPanelStateMap(
  states: ToolPanelStateMap,
  key: string,
  createState: () => ToolPanelState,
  update: ToolPanelStateUpdate,
): ToolPanelStateMap {
  const current = states[key] ?? createState();
  const next = update(current);
  return next === current ? states : { ...states, [key]: next };
}

export function transferToolPanelState(
  states: ToolPanelStateMap,
  sourceKey: string,
  targetKey: string,
): ToolPanelStateMap {
  const source = states[sourceKey];
  if (!source || sourceKey === targetKey) return states;
  const next = { ...states, [targetKey]: source };
  delete next[sourceKey];
  return next;
}

export function removeToolPanelStateKeys(
  states: ToolPanelStateMap,
  keys: Iterable<string>,
): ToolPanelStateMap {
  const removed = new Set(keys);
  const entries = Object.entries(states).filter(([key]) => !removed.has(key));
  return entries.length === Object.keys(states).length
    ? states
    : Object.fromEntries(entries);
}
