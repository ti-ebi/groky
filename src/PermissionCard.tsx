import type { PermissionRequest } from "./sessionTypes";

function permissionOptionClass(kind: string) {
  switch (kind) {
    case "allow_once":
      return "allow-once";
    case "allow_always":
      return "allow-always";
    case "reject_always":
      return "reject reject-always";
    case "reject_once":
      return "reject";
    default:
      return kind.includes("reject") ? "reject" : "allow-once";
  }
}

export function PermissionCard({
  permission,
  busy,
  onRespond,
}: {
  permission: PermissionRequest;
  busy: boolean;
  onRespond: (optionId: string | null) => void;
}) {
  const hasRejectOption = permission.options.some((option) => option.kind.startsWith("reject"));

  return (
    <aside className="permission-card" aria-live="assertive">
      <div className="permission-glyph">!</div>
      <div className="permission-copy">
        <span className="message-kicker">APPROVAL REQUIRED</span>
        <strong>{permission.title}</strong>
        <small>{permission.toolKind?.replace(/_/g, " ") ?? "Local tool action"}</small>
        <div className="permission-actions">
          {permission.options.map((option) => (
            <button
              className={permissionOptionClass(option.kind)}
              type="button"
              disabled={busy}
              key={option.optionId}
              onClick={() => onRespond(option.optionId)}
            >
              {busy ? "Responding…" : option.name}
            </button>
          ))}
          {!hasRejectOption && (
            <button className="reject" type="button" disabled={busy} onClick={() => onRespond(null)}>Cancel request</button>
          )}
        </div>
      </div>
    </aside>
  );
}
