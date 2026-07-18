import { useEffect, useRef, useState } from "react";
import { workspaceName } from "../shared/path";
import { Icon } from "../ui/Icon";

export function SessionLocationSelector({
  value,
  workspaces,
  disabled,
  onChange,
  onAddWorkspace,
}: {
  value: string | null;
  workspaces: string[];
  disabled: boolean;
  onChange: (workspace: string | null) => void;
  onAddWorkspace: () => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [addingWorkspace, setAddingWorkspace] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const label = value ? workspaceName(value) : "Standalone";
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredWorkspaces = workspaces.filter((path) =>
    !normalizedQuery
    || workspaceName(path).toLocaleLowerCase().includes(normalizedQuery)
    || path.toLocaleLowerCase().includes(normalizedQuery)
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const frame = window.requestAnimationFrame(() => searchInput.current?.focus());
    const handlePointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function select(workspace: string | null) {
    onChange(workspace);
    setOpen(false);
  }

  async function addWorkspace() {
    setOpen(false);
    setAddingWorkspace(true);
    const added = await onAddWorkspace();
    setAddingWorkspace(false);
    if (added) onChange(added);
  }

  return (
    <div className="session-location-control" ref={root}>
      <button
        className="session-location-button"
        type="button"
        aria-label={`Session location: ${label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled || addingWorkspace}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name={value ? "folder" : "standalone"} size={14} />
        <span>{label}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {open && (
        <div className="session-location-menu" role="menu" aria-label="Working directory for this session">
          <label className="session-location-search">
            <Icon name="search" size={13} />
            <input
              ref={searchInput}
              type="search"
              aria-label="Search working directories"
              placeholder="Search working directories"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="session-location-workspaces">
            {filteredWorkspaces.map((path) => (
              <button
                className="session-location-option"
                type="button"
                role="menuitemradio"
                aria-checked={value === path}
                key={path}
                title={path}
                onClick={() => select(path)}
              >
                <Icon name="folder" size={14} />
                <span>{workspaceName(path)}</span>
                {value === path && <Icon name="check" size={14} />}
              </button>
            ))}
            {filteredWorkspaces.length === 0 && (
              <p className="session-location-empty">
                {workspaces.length === 0 ? "No working directories yet" : "No matching working directories"}
              </p>
            )}
          </div>
          <div className="session-location-actions">
            <button className="session-location-action" type="button" role="menuitem" onClick={() => void addWorkspace()}>
              <Icon name="plus" size={14} />
              <span>Add working directory</span>
            </button>
            <button
              className="session-location-action"
              type="button"
              role="menuitemradio"
              aria-checked={value === null}
              onClick={() => select(null)}
            >
              <Icon name="standalone" size={14} />
              <span>Standalone</span>
              {value === null && <Icon name="check" size={14} />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

