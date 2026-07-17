export type AppUpdatePhase = "idle" | "checking" | "available" | "downloading" | "error";
export type SettingsSection = "application" | "grok" | "account" | "archived";

export const SETTINGS_SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  description: string;
}> = [
  { id: "application", label: "Application", description: "Version and signed desktop updates" },
  { id: "grok", label: "Grok Build", description: "CLI and active session details" },
  { id: "account", label: "Account", description: "Authentication and sign out" },
  { id: "archived", label: "Archived chats", description: "Restore or delete archived chats" },
];
