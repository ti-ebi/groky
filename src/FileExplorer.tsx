import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "./files/FileExplorer.css";
import { FilePreviewPane, type FilePreviewState } from "./files/FilePreview";
import { host } from "./host";
import type {
  WorkspaceDirectoryListing,
  WorkspaceFileAttachment,
  WorkspaceFileEntry,
  WorkspaceFileTarget,
} from "./host/types";
import {
  ExplorerIcon,
  fileIconName,
  fileVisualKind,
  formatWorkspaceFileSize,
  parentPath,
} from "./files/fileVisuals";
import { workspaceName } from "./shared/path";
import type { ToolPanelAttachmentResult } from "./session/toolPanel";

type DirectoryStatus = "loading" | "ready" | "error";

const DEFAULT_PREVIEW_WIDTH_RATIO = 0.62;
const MIN_PREVIEW_PANE_WIDTH = 190;
const MIN_FILE_TREE_WIDTH = 132;
const FILE_EXPLORER_DIVIDER_WIDTH = 7;

function maximumPreviewPaneWidth(containerWidth: number) {
  return Math.max(
    MIN_PREVIEW_PANE_WIDTH,
    containerWidth - MIN_FILE_TREE_WIDTH - FILE_EXPLORER_DIVIDER_WIDTH,
  );
}

function clampPreviewPaneWidth(width: number, containerWidth: number) {
  return Math.min(
    maximumPreviewPaneWidth(containerWidth),
    Math.max(MIN_PREVIEW_PANE_WIDTH, width),
  );
}

function defaultPreviewPaneWidth(containerWidth: number) {
  return clampPreviewPaneWidth(containerWidth * DEFAULT_PREVIEW_WIDTH_RATIO, containerWidth);
}

interface DirectoryState {
  status: DirectoryStatus;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
  error?: string;
}

interface VisibleFileRow {
  entry: WorkspaceFileEntry;
  depth: number;
}

function directoryMatchesListing(
  directory: DirectoryState,
  listing: WorkspaceDirectoryListing,
) {
  return directory.status === "ready"
    && directory.truncated === listing.truncated
    && directory.entries.length === listing.entries.length
    && directory.entries.every((entry, index) => {
      const next = listing.entries[index];
      return next !== undefined
        && entry.name === next.name
        && entry.path === next.path
        && entry.kind === next.kind
        && entry.size === next.size
        && entry.modifiedAt === next.modifiedAt
        && entry.hidden === next.hidden;
    });
}

export function FileExplorer({
  active,
  sessionId,
  workspace,
  workingDirectory,
  attachmentDisabled,
  onAttach,
}: {
  active: boolean;
  sessionId: string | null;
  workspace: string | null;
  workingDirectory: string | null;
  attachmentDisabled: boolean;
  onAttach: (attachment: WorkspaceFileAttachment) => ToolPanelAttachmentResult;
}) {
  const directoryRef = useRef<Record<string, DirectoryState>>({});
  const loadingPaths = useRef<Set<string>>(new Set());
  const requestGeneration = useRef(0);
  const previewGeneration = useRef(0);
  const activeRef = useRef(active);
  const targetKeyRef = useRef<string | null>(null);
  const previewStateRef = useRef<FilePreviewState | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const splitPaneRef = useRef<HTMLDivElement>(null);
  const splitResizeStart = useRef<{ pointerX: number; previewWidth: number } | null>(null);
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(true);
  const [attachingPath, setAttachingPath] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<FilePreviewState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openingFolder, setOpeningFolder] = useState(false);
  const [splitPaneWidth, setSplitPaneWidth] = useState(0);
  const [previewPaneWidth, setPreviewPaneWidth] = useState<number | null>(null);
  const target = useMemo<WorkspaceFileTarget | null>(() => {
    if (!workspace) return null;
    return sessionId ? { sessionId } : { workingDirectory: workspace };
  }, [sessionId, workspace]);
  const targetKey = target
    ? sessionId ? `session:${sessionId}` : `workspace:${workspace}`
    : null;
  useLayoutEffect(() => {
    activeRef.current = active;
    targetKeyRef.current = targetKey;
  }, [active, targetKey]);

  useEffect(() => {
    const splitPane = splitPaneRef.current;
    if (!splitPane) return;

    const updateWidth = () => {
      const width = splitPane.clientWidth;
      if (width <= 0) return;
      setSplitPaneWidth(width);
      setPreviewPaneWidth((current) => (
        current === null
          ? defaultPreviewPaneWidth(width)
          : clampPreviewPaneWidth(current, width)
      ));
    };

    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(splitPane);
    updateWidth();
    return () => resizeObserver.disconnect();
  }, [targetKey]);

  useEffect(() => () => {
    document.body.classList.remove("is-resizing-file-preview");
  }, []);

  useEffect(() => {
    previewStateRef.current = previewState;
  }, [previewState]);

  const commitDirectories = useCallback((
    update: (current: Record<string, DirectoryState>) => Record<string, DirectoryState>,
  ) => {
    setDirectories((current) => {
      const next = update(current);
      directoryRef.current = next;
      return next;
    });
  }, []);

  const loadDirectory = useCallback(async (path: string, force = false, background = false) => {
    if (!target || loadingPaths.current.has(path)) return;
    if (!force && directoryRef.current[path]?.status === "ready") return;

    const generation = requestGeneration.current;
    loadingPaths.current.add(path);
    if (!background || directoryRef.current[path]?.status !== "ready") {
      commitDirectories((current) => ({
        ...current,
        [path]: {
          entries: current[path]?.entries ?? [],
          truncated: current[path]?.truncated ?? false,
          status: "loading",
        },
      }));
    }

    try {
      const listing = await host.workspaceFiles.list(target, path);
      if (generation !== requestGeneration.current) return;
      commitDirectories((current) => {
        const previous = current[path];
        if (previous && directoryMatchesListing(previous, listing)) return current;
        return {
          ...current,
          [path]: {
          entries: listing.entries,
          truncated: listing.truncated,
          status: "ready",
          },
        };
      });
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      commitDirectories((current) => {
        if (background && current[path]?.status === "ready") return current;
        return {
          ...current,
          [path]: {
          entries: current[path]?.entries ?? [],
          truncated: false,
          status: "error",
          error: String(error),
          },
        };
      });
    } finally {
      loadingPaths.current.delete(path);
    }
  }, [commitDirectories, target]);

  useEffect(() => {
    requestGeneration.current += 1;
    previewGeneration.current += 1;
    loadingPaths.current.clear();
    directoryRef.current = {};
    setDirectories({});
    setExpanded(new Set());
    setSelectedPath(null);
    setAttachingPath(null);
    setOpeningFolder(false);
    setPreviewState(null);
    setNotice(null);
  }, [targetKey]);

  useEffect(() => {
    if (active) return;
    requestGeneration.current += 1;
    previewGeneration.current += 1;
    loadingPaths.current.clear();
    setAttachingPath(null);
  }, [active]);

  useEffect(() => {
    if (active && target) void loadDirectory("");
  }, [active, loadDirectory, target]);

  const rows = useMemo(() => {
    const visibleRows: VisibleFileRow[] = [];
    const appendDirectory = (path: string, depth: number) => {
      const directory = directories[path];
      if (!directory) return;
      directory.entries.forEach((entry) => {
        if (!showHidden && entry.hidden) return;
        visibleRows.push({ entry, depth });
        if (entry.kind === "directory" && expanded.has(entry.path)) {
          appendDirectory(entry.path, depth + 1);
        }
      });
    };
    appendDirectory("", 0);
    return visibleRows;
  }, [directories, expanded, showHidden]);

  useEffect(() => {
    if (rows.length === 0) {
      setSelectedPath(null);
      return;
    }
    if (!selectedPath || !rows.some(({ entry }) => entry.path === selectedPath)) {
      setSelectedPath(rows[0].entry.path);
    }
  }, [rows, selectedPath]);

  const selectedEntry = rows.find(({ entry }) => entry.path === selectedPath)?.entry ?? null;
  const folderToOpen = selectedEntry
    ? selectedEntry.kind === "directory" ? selectedEntry.path : parentPath(selectedEntry.path)
    : "";
  const openFolderLabel = selectedEntry
    ? selectedEntry.kind === "directory"
      ? `Open ${selectedEntry.name} in file manager`
      : `Open folder containing ${selectedEntry.name}`
    : "Open workspace folder in file manager";
  const rootState = directories[""];
  const hasTruncatedDirectory = Object.values(directories).some((directory) => directory.truncated);

  function focusRow(path: string) {
    setSelectedPath(path);
    window.requestAnimationFrame(() => rowRefs.current.get(path)?.focus());
  }

  function toggleDirectory(entry: WorkspaceFileEntry) {
    if (entry.kind !== "directory") return;
    if (expanded.has(entry.path)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(entry.path);
        return next;
      });
      return;
    }
    setExpanded((current) => new Set(current).add(entry.path));
    void loadDirectory(entry.path);
  }

  const previewFile = useCallback(async (entry: WorkspaceFileEntry, background = false) => {
    if (!target || entry.kind === "directory") return;
    const generation = ++previewGeneration.current;
    setSelectedPath(entry.path);
    if (!background) setPreviewState({ status: "loading", entry });
    try {
      const preview = await host.workspaceFiles.preview(target, entry.path);
      if (generation === previewGeneration.current) {
        setPreviewState({ status: "ready", entry, preview });
      }
    } catch (error) {
      if (generation === previewGeneration.current) {
        setPreviewState({ status: "error", entry, error: String(error) });
      }
    }
  }, [target]);

  useEffect(() => {
    if (!active || !target) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    let refreshTimer = 0;
    let refreshAll = false;
    const changedPaths = new Set<string>();
    const watchId = crypto.randomUUID();

    const refreshLoadedDirectories = (paths: string[]) => {
      const loadedDirectories = directoryRef.current;
      const directoriesToRefresh = new Set<string>();
      if (paths.length === 0) {
        Object.keys(loadedDirectories).forEach((path) => directoriesToRefresh.add(path));
      } else {
        paths.forEach((changedPath) => {
          if (loadedDirectories[changedPath]) directoriesToRefresh.add(changedPath);
          let directory = parentPath(changedPath);
          while (true) {
            if (loadedDirectories[directory]) {
              directoriesToRefresh.add(directory);
              break;
            }
            if (!directory) break;
            directory = parentPath(directory);
          }
        });
      }
      directoriesToRefresh.forEach((path) => void loadDirectory(path, true, true));

      const previewEntry = previewStateRef.current?.entry;
      if (previewEntry && (paths.length === 0 || paths.includes(previewEntry.path))) {
        void previewFile(previewEntry, true);
      }
    };

    const scheduleRefresh = (paths: string[]) => {
      if (paths.length === 0) refreshAll = true;
      paths.forEach((path) => changedPaths.add(path));
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        const pathsToRefresh = refreshAll ? [] : Array.from(changedPaths);
        refreshAll = false;
        changedPaths.clear();
        refreshLoadedDirectories(pathsToRefresh);
      }, 140);
    };

    void host.workspaceFiles.onChanged((payload) => {
      if (payload.watchId === watchId) scheduleRefresh(payload.paths);
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });
    const watchStarted = host.workspaceFiles.watch(target, watchId);
    void watchStarted.catch(() => undefined);

    const reconciliationTimer = window.setInterval(() => scheduleRefresh([]), 15_000);
    return () => {
      disposed = true;
      window.clearTimeout(refreshTimer);
      window.clearInterval(reconciliationTimer);
      unlisten?.();
      void watchStarted
        .then(() => host.workspaceFiles.unwatch(watchId))
        .catch(() => undefined);
    };
  }, [active, loadDirectory, previewFile, target]);

  function activateEntry(entry: WorkspaceFileEntry) {
    setSelectedPath(entry.path);
    if (entry.kind === "directory") {
      toggleDirectory(entry);
    } else {
      void previewFile(entry);
    }
  }

  async function openSelectedFolder() {
    if (!target || openingFolder) return;
    setOpeningFolder(true);
    setNotice(null);
    try {
      await host.workspaceFiles.openFolder(target, folderToOpen);
      setNotice(selectedEntry && selectedEntry.kind !== "directory"
        ? `Opened the folder containing ${selectedEntry.name}.`
        : "Opened the selected folder in the system file manager.");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setOpeningFolder(false);
    }
  }

  async function attachFile(entry: WorkspaceFileEntry) {
    if (!target || entry.kind !== "file" || attachmentDisabled || attachingPath) return;
    const generation = requestGeneration.current;
    const requestTargetKey = targetKey;
    setAttachingPath(entry.path);
    setNotice(null);
    try {
      const attachment = await host.workspaceFiles.inspectAttachment(target, entry.path);
      if (
        !activeRef.current
        || requestTargetKey !== targetKeyRef.current
        || generation !== requestGeneration.current
      ) return;
      const result = onAttach(attachment);
      if (result === "added") setNotice(`${entry.name} attached to the next message.`);
      else if (result === "duplicate") setNotice(`${entry.name} is already attached.`);
      else if (result === "limit") setNotice("The attachment limit has been reached.");
    } catch (error) {
      if (
        activeRef.current
        && requestTargetKey === targetKeyRef.current
        && generation === requestGeneration.current
      ) setNotice(String(error));
    } finally {
      if (
        activeRef.current
        && requestTargetKey === targetKeyRef.current
        && generation === requestGeneration.current
      ) setAttachingPath(null);
    }
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLDivElement>, row: VisibleFileRow, index: number) {
    const { entry } = row;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const nextRow = rows[Math.min(rows.length - 1, Math.max(0, index + offset))];
      if (nextRow) focusRow(nextRow.entry.path);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const nextRow = event.key === "Home" ? rows[0] : rows[rows.length - 1];
      if (nextRow) focusRow(nextRow.entry.path);
      return;
    }
    if (event.key === "ArrowRight" && entry.kind === "directory") {
      event.preventDefault();
      if (!expanded.has(entry.path)) {
        toggleDirectory(entry);
      } else {
        const child = rows[index + 1];
        if (child && child.depth > row.depth) focusRow(child.entry.path);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      if (entry.kind === "directory" && expanded.has(entry.path)) {
        event.preventDefault();
        toggleDirectory(entry);
        return;
      }
      const parent = parentPath(entry.path);
      const parentRow = rows.find(({ entry: candidate }) => candidate.path === parent);
      if (parentRow) {
        event.preventDefault();
        focusRow(parentRow.entry.path);
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateEntry(entry);
    }
  }

  function currentSplitPaneWidth() {
    return splitPaneRef.current?.clientWidth || splitPaneWidth;
  }

  function effectivePreviewPaneWidth() {
    const containerWidth = currentSplitPaneWidth();
    if (containerWidth <= 0) return MIN_PREVIEW_PANE_WIDTH;
    return clampPreviewPaneWidth(
      previewPaneWidth ?? defaultPreviewPaneWidth(containerWidth),
      containerWidth,
    );
  }

  function startSplitResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    splitResizeStart.current = {
      pointerX: event.clientX,
      previewWidth: effectivePreviewPaneWidth(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing-file-preview");
  }

  function resizeSplit(event: ReactPointerEvent<HTMLDivElement>) {
    const start = splitResizeStart.current;
    if (!start) return;
    const containerWidth = currentSplitPaneWidth();
    if (containerWidth <= 0) return;
    setPreviewPaneWidth(clampPreviewPaneWidth(
      start.previewWidth + event.clientX - start.pointerX,
      containerWidth,
    ));
  }

  function finishSplitResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!splitResizeStart.current) return;
    splitResizeStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("is-resizing-file-preview");
  }

  function resizeSplitWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    const containerWidth = currentSplitPaneWidth();
    if (containerWidth <= 0) return;
    const step = event.shiftKey ? 32 : 12;
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = effectivePreviewPaneWidth() - step;
    if (event.key === "ArrowRight") nextWidth = effectivePreviewPaneWidth() + step;
    if (event.key === "Home") nextWidth = MIN_PREVIEW_PANE_WIDTH;
    if (event.key === "End") nextWidth = maximumPreviewPaneWidth(containerWidth);
    if (nextWidth === null) return;
    event.preventDefault();
    setPreviewPaneWidth(clampPreviewPaneWidth(nextWidth, containerWidth));
  }

  function resetSplitWidth() {
    const containerWidth = currentSplitPaneWidth();
    if (containerWidth > 0) setPreviewPaneWidth(defaultPreviewPaneWidth(containerWidth));
  }

  if (!target) {
    return (
      <div className="file-explorer-unavailable" role="status">
        <span className="file-explorer-unavailable-icon"><ExplorerIcon name="folder" size={18} /></span>
        <strong>Files are unavailable in standalone mode</strong>
        <p>Choose a working directory before starting a session to browse its files.</p>
      </div>
    );
  }

  return (
    <section className="file-explorer" aria-label="Workspace files">
      <div
        className="file-explorer-body"
        ref={splitPaneRef}
        style={{
          "--file-preview-width": previewPaneWidth === null
            ? `${DEFAULT_PREVIEW_WIDTH_RATIO * 100}%`
            : `${previewPaneWidth}px`,
        } as React.CSSProperties}
      >
        <div className="file-explorer-browser">
      <header className="file-explorer-header">
        <div className="file-explorer-heading" title={workingDirectory ?? undefined}>
          <span>WORKSPACE</span>
          <strong>{workspaceName(workingDirectory, "Workspace")}</strong>
        </div>
        <div className="file-explorer-actions">
          <button
            type="button"
            aria-label={openFolderLabel}
            title={openFolderLabel}
            disabled={openingFolder}
            onClick={() => void openSelectedFolder()}
          >
            <ExplorerIcon name="open" size={14} />
          </button>
          <button
            type="button"
            aria-label={showHidden ? "Hide hidden files" : "Show hidden files"}
            aria-pressed={showHidden}
            title={showHidden ? "Hide hidden files" : "Show hidden files"}
            onClick={() => setShowHidden((current) => !current)}
          >
            <ExplorerIcon name={showHidden ? "eye" : "eye-off"} size={14} />
          </button>
        </div>
      </header>

      <div className="file-explorer-tree-wrap">
        {(!rootState || rootState.status === "loading") && (
          <div className="file-tree-loading" role="status" aria-live="polite">
            {[0, 1, 2, 3, 4, 5].map((index) => <span key={index} style={{ width: `${56 + ((index * 17) % 31)}%` }} />)}
            <small>Reading workspace…</small>
          </div>
        )}
        {rootState?.status === "error" && (
          <div className="file-tree-error" role="alert">
            <span><ExplorerIcon name="folder" size={17} /></span>
            <strong>Could not read this workspace</strong>
            <p>{rootState.error}</p>
            <button type="button" onClick={() => void loadDirectory("", true)}>Try again</button>
          </div>
        )}
        {rootState?.status === "ready" && rows.length === 0 && (
          <div className="file-tree-empty" role="status">
            <span><ExplorerIcon name="folder-open" size={18} /></span>
            <strong>{rootState.entries.length === 0 ? "This folder is empty" : "Hidden files are filtered"}</strong>
            <p>{rootState.entries.length === 0 ? "New files will appear here automatically." : "Show hidden files to see this workspace."}</p>
          </div>
        )}
        {rootState?.status === "ready" && rows.length > 0 && (
          <div
            className="file-tree"
            role="tree"
            aria-label={`${workspaceName(workingDirectory, "Workspace")} files`}
          >
            {rows.map((row, index) => {
              const { entry, depth } = row;
              const selected = selectedPath === entry.path;
              const isExpanded = entry.kind === "directory" && expanded.has(entry.path);
              const directoryState = entry.kind === "directory" ? directories[entry.path] : undefined;
              const loading = directoryState?.status === "loading";
              return (
                <div
                  className="file-tree-row"
                  data-file-kind={fileVisualKind(entry)}
                  data-loading={loading || undefined}
                  data-selected={selected}
                  key={entry.path}
                  ref={(element) => {
                    if (element) rowRefs.current.set(entry.path, element);
                    else rowRefs.current.delete(entry.path);
                  }}
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-selected={selected}
                  aria-expanded={entry.kind === "directory" ? isExpanded : undefined}
                  tabIndex={selected ? 0 : -1}
                  title={entry.path}
                  style={{ "--file-depth": depth } as React.CSSProperties}
                  onClick={(event) => {
                    if (event.detail > 1) return;
                    activateEntry(entry);
                  }}
                  onKeyDown={(event) => handleRowKeyDown(event, row, index)}
                >
                  <span className={`file-tree-chevron ${isExpanded ? "expanded" : ""}`} aria-hidden="true">
                    {entry.kind === "directory" && <ExplorerIcon name="chevron" size={12} />}
                  </span>
                  <span className="file-tree-kind-icon">
                    <ExplorerIcon name={fileIconName(entry, isExpanded)} size={15} />
                  </span>
                  <span className="file-tree-name">{entry.name}</span>
                  {entry.kind === "file" && (
                    <button
                      className="file-tree-attach"
                      type="button"
                      aria-label={`Attach ${entry.name}`}
                      title="Attach to next message"
                      disabled={attachmentDisabled || attachingPath !== null}
                      onClick={(event) => {
                        event.stopPropagation();
                        void attachFile(entry);
                      }}
                    >
                      <ExplorerIcon name="paperclip" size={12} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <footer className="file-explorer-footer">
        <div className="file-explorer-selection" title={selectedEntry?.path}>
          {selectedEntry ? (
            <>
              <span className="file-explorer-selection-icon" data-file-kind={fileVisualKind(selectedEntry)}>
                <ExplorerIcon name={fileIconName(selectedEntry, expanded.has(selectedEntry.path))} size={13} />
              </span>
              <span>{selectedEntry.path}</span>
              {selectedEntry.kind === "file" && <small>{formatWorkspaceFileSize(selectedEntry.size)}</small>}
            </>
          ) : <span>No file selected</span>}
        </div>
        {hasTruncatedDirectory && <span className="file-explorer-limit">5,000 item limit</span>}
      </footer>
        </div>
        <div
          className="file-explorer-divider"
          role="separator"
          aria-label="Resize file preview and file tree"
          aria-orientation="vertical"
          aria-valuemin={MIN_PREVIEW_PANE_WIDTH}
          aria-valuemax={Math.round(maximumPreviewPaneWidth(splitPaneWidth))}
          aria-valuenow={Math.round(effectivePreviewPaneWidth())}
          aria-valuetext={splitPaneWidth > 0
            ? `Preview ${Math.round(effectivePreviewPaneWidth() / splitPaneWidth * 100)} percent`
            : undefined}
          tabIndex={0}
          title="Drag to resize. Double-click to reset."
          onDoubleClick={resetSplitWidth}
          onKeyDown={resizeSplitWithKeyboard}
          onPointerDown={startSplitResize}
          onPointerMove={resizeSplit}
          onPointerUp={finishSplitResize}
          onPointerCancel={finishSplitResize}
        />
        <FilePreviewPane
          state={previewState}
          target={target}
          attachmentDisabled={attachmentDisabled}
          attaching={attachingPath === previewState?.entry.path}
          onAttach={(entry) => void attachFile(entry)}
        />
      </div>
      <div className="file-explorer-announcer" aria-live="polite">
        {attachingPath ? "Attaching file…" : notice}
      </div>
    </section>
  );
}
