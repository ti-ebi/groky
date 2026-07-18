export interface SidebarSessionSummary {
  sessionId: string;
  title: string;
  workspace: string | null;
  running: boolean;
  needsAttention: boolean;
  updatedAt: number;
  archived: boolean;
  unread: boolean;
}
