import type { ApprovalMode, PermissionOption } from "./types";
import type { IconName } from "../ui/Icon";

export interface ApprovalModeOption {
  id: ApprovalMode;
  label: string;
  shortDescription: string;
  description: string;
  icon: IconName;
  tag?: string;
}

export const APPROVAL_MODE_STORAGE_KEY = "groky.approvalMode";

export const APPROVAL_MODES: ApprovalModeOption[] = [
  {
    id: "normal",
    label: "Normal",
    shortDescription: "Review actions",
    description: "Ask before actions that are not already allowed.",
    icon: "shield",
  },
  {
    id: "plan",
    label: "Plan",
    shortDescription: "Plan before editing",
    description: "Explore the workspace and propose a plan before writing files.",
    icon: "file-plan",
  },
  {
    id: "auto",
    label: "Auto",
    shortDescription: "Approve safe actions",
    description: "Use Grok's classifier to approve safe actions and ask for risky ones.",
    icon: "gauge",
  },
  {
    id: "alwaysApprove",
    label: "Always-Approve",
    shortDescription: "Approval prompts skipped",
    description: "Skip prompts unless a policy rule still requires approval.",
    icon: "triangle-alert",
  },
];

export function approvalModeOption(mode: ApprovalMode) {
  return APPROVAL_MODES.find((option) => option.id === mode) ?? APPROVAL_MODES[0];
}

export function normalizeApprovalMode(value: unknown): ApprovalMode {
  if (value === "plan" || value === "auto" || value === "alwaysApprove") return value;
  return "normal";
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
