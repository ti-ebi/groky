import type { SidebarSessionSummary } from "./types";

export interface SidebarWorkspaceGroup {
  path: string;
  sessions: SidebarSessionSummary[];
}

function sidebarSessionPriority(session: SidebarSessionSummary) {
  if (session.needsAttention) return 0;
  if (session.unread) return 1;
  if (session.running) return 2;
  return 3;
}

export function compareSidebarSessions(left: SidebarSessionSummary, right: SidebarSessionSummary) {
  return sidebarSessionPriority(left) - sidebarSessionPriority(right)
    || right.updatedAt - left.updatedAt;
}

export function groupSidebarSessions(sessions: SidebarSessionSummary[]) {
  const groups = new Map<string, SidebarSessionSummary[]>();
  const ungrouped: SidebarSessionSummary[] = [];

  sessions.forEach((session) => {
    if (!session.workspace) {
      ungrouped.push(session);
      return;
    }

    const group = groups.get(session.workspace) ?? [];
    group.push(session);
    groups.set(session.workspace, group);
  });

  return {
    workspaceGroups: Array.from(groups, ([path, groupedSessions]) => ({
      path,
      sessions: groupedSessions,
    })),
    ungrouped,
  };
}
