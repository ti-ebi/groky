import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { flushSync } from "react-dom";
import "./TerminalPanel.css";
import type { ResolvedAppearance } from "./appearance";
import { FileExplorer } from "./FileExplorer";
import type { TerminalInfo, WorkspaceFileAttachment } from "./host/types";
import {
  removeUnavailableFileTabs,
  type TerminalToolTabState as TerminalToolTab,
  type ToolPanelAttachmentResult,
  type ToolPanelState,
  type ToolPanelStateUpdate,
  type ToolPanelTabState as ToolTab,
} from "./session/toolPanel";
import { compactPath } from "./shared/path";
import { TerminalSurface, type TerminalStatus } from "./terminal/TerminalSurface";

function PanelIcon({ name, size = 15 }: { name: "files" | "plus" | "terminal" | "x"; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {name === "plus" && <><path d="M12 5v14" /><path d="M5 12h14" /></>}
      {name === "files" && <><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M7 11h10M7 15h7" /></>}
      {name === "terminal" && <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3M13 15h4" /></>}
      {name === "x" && <><path d="m7 7 10 10" /><path d="M17 7 7 17" /></>}
    </svg>
  );
}

interface TabPointerDrag {
  tabId: string;
  pointerId: number;
  startX: number;
  startY: number;
  pointerX: number;
  grabOffsetX: number;
  offsetX: number;
  initialIndex: number;
  previewIndex: number;
  shiftDistance: number;
  maxScrollLeft: number;
  dragging: boolean;
  element: HTMLElement;
}

const TAB_DRAG_THRESHOLD = 5;
const TAB_AUTO_SCROLL_MAX_STEP = 6;

function tabLayoutBounds(item: HTMLElement) {
  const bounds = item.getBoundingClientRect();
  const transform = window.getComputedStyle(item).transform;
  const translateX = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
  return {
    left: bounds.left - translateX,
    right: bounds.right - translateX,
  };
}

function tabReorderIndexAt(
  tabList: HTMLDivElement,
  tabs: ToolTab[],
  clientX: number,
  draggedTabId: string,
): number {
  const sourceIndex = tabs.findIndex((tab) => tab.id === draggedTabId);
  if (sourceIndex < 0) return sourceIndex;

  const items = new Map(Array.from(
    tabList.querySelectorAll<HTMLElement>(".side-panel-tab-item[data-tool-tab-id]"),
  ).flatMap((item) => item.dataset.toolTabId ? [[item.dataset.toolTabId, item] as const] : []));

  let targetIndex = sourceIndex;
  for (let index = sourceIndex + 1; index < tabs.length; index += 1) {
    const item = items.get(tabs[index].id);
    if (!item || clientX < tabLayoutBounds(item).left) break;
    targetIndex = index;
  }
  if (targetIndex > sourceIndex) return targetIndex;

  for (let index = sourceIndex - 1; index >= 0; index -= 1) {
    const item = items.get(tabs[index].id);
    if (!item || clientX > tabLayoutBounds(item).right) break;
    targetIndex = index;
  }
  return targetIndex;
}

function reorderTab(tabs: ToolTab[], draggedTabId: string, insertionIndex: number) {
  const sourceIndex = tabs.findIndex((tab) => tab.id === draggedTabId);
  if (sourceIndex < 0) return tabs;

  const nextTabs = [...tabs];
  const [draggedTab] = nextTabs.splice(sourceIndex, 1);
  if (!draggedTab) return tabs;

  nextTabs.splice(Math.max(0, Math.min(nextTabs.length, insertionIndex)), 0, draggedTab);
  return nextTabs.every((tab, index) => tab.id === tabs[index]?.id) ? tabs : nextTabs;
}

interface TerminalTabMeta {
  label: string;
  fullPath: string | null;
  status: TerminalStatus;
}

function TerminalToolView({
  tab,
  active,
  appearance,
  panelOpen,
  onMetaChange,
}: {
  tab: TerminalToolTab;
  active: boolean;
  appearance: ResolvedAppearance;
  panelOpen: boolean;
  onMetaChange: (tabId: string, meta: TerminalTabMeta) => void;
}) {
  const [restartToken, setRestartToken] = useState(0);
  const [info, setInfo] = useState<TerminalInfo | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("starting");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const fullPath = info?.workingDirectory ?? tab.workingDirectory;

  useEffect(() => {
    onMetaChange(tab.id, {
      label: compactPath(fullPath),
      fullPath,
      status,
    });
  }, [fullPath, onMetaChange, status, tab.id]);

  function restart() {
    setStatusMessage(null);
    setRestartToken((current) => current + 1);
  }

  return (
    <div
      id={`tool-content-${tab.id}`}
      className="terminal-stage"
      role="tabpanel"
      aria-labelledby={`tool-tab-${tab.id}`}
      hidden={!active}
    >
        <TerminalSurface
          active={active}
          appearance={appearance}
          panelOpen={panelOpen}
          workingDirectory={tab.workingDirectory}
          restartToken={restartToken}
          onInfoChange={setInfo}
          onStatusChange={(nextStatus, message) => {
            setStatus(nextStatus);
            setStatusMessage(message ?? null);
          }}
        />
        {status !== "running" && (
          <div className={`terminal-status-card ${status}`} role="status" aria-live="polite">
            <span className="terminal-status-mark"><PanelIcon name="terminal" size={17} /></span>
            <strong>{status === "starting" ? "Starting shell…" : status === "exited" ? "Terminal finished" : "Terminal unavailable"}</strong>
            {statusMessage && <p>{statusMessage}</p>}
            {status !== "starting" && <button type="button" onClick={restart}>Start a new terminal</button>}
          </div>
        )}
    </div>
  );
}

export function TerminalPanel({
  active,
  appearance,
  panelKey,
  state,
  sessionId,
  workspace,
  workingDirectory,
  attachmentDisabled,
  onAttach,
  onStateChange,
}: {
  active: boolean;
  appearance: ResolvedAppearance;
  panelKey: string;
  state: ToolPanelState;
  sessionId: string | null;
  workspace: string | null;
  workingDirectory: string | null;
  attachmentDisabled: boolean;
  onAttach: (attachment: WorkspaceFileAttachment) => ToolPanelAttachmentResult;
  onStateChange: (key: string, update: ToolPanelStateUpdate) => void;
}) {
  const { tabs, activeTabId } = state;
  const open = active && state.open;
  const tabHeader = useRef<HTMLDivElement | null>(null);
  const tabList = useRef<HTMLDivElement | null>(null);
  const addMenuRoot = useRef<HTMLDivElement | null>(null);
  const addMenuTrigger = useRef<HTMLButtonElement | null>(null);
  const addMenu = useRef<HTMLDivElement | null>(null);
  const addFilesItem = useRef<HTMLButtonElement | null>(null);
  const addTerminalItem = useRef<HTMLButtonElement | null>(null);
  const tabPointerDrag = useRef<TabPointerDrag | null>(null);
  const tabDragFrame = useRef<number | null>(null);
  const suppressTabClick = useRef(false);
  const suppressTabClickTimer = useRef<number | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [tabMeta, setTabMeta] = useState<Record<string, TerminalTabMeta>>({});
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addMenuLeft, setAddMenuLeft] = useState(8);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [tabOrderAnnouncement, setTabOrderAnnouncement] = useState("");
  const changeState = useCallback((update: ToolPanelStateUpdate) => {
    onStateChange(panelKey, update);
  }, [onStateChange, panelKey]);

  const clearTabDrag = useCallback(() => {
    if (tabDragFrame.current !== null) {
      window.cancelAnimationFrame(tabDragFrame.current);
      tabDragFrame.current = null;
    }
    clearTabReorderPreview();
    tabPointerDrag.current?.element.style.removeProperty("--tool-tab-drag-x");
    tabPointerDrag.current = null;
    setDraggedTabId(null);
    document.body.classList.remove("is-dragging-tool-tab");
  }, []);

  useEffect(() => () => {
    if (tabDragFrame.current !== null) window.cancelAnimationFrame(tabDragFrame.current);
    tabList.current?.querySelectorAll<HTMLElement>(".side-panel-tab-item").forEach((item) => {
      item.style.removeProperty("--tool-tab-reorder-x");
    });
    tabPointerDrag.current?.element.style.removeProperty("--tool-tab-drag-x");
    tabPointerDrag.current = null;
    if (suppressTabClickTimer.current !== null) window.clearTimeout(suppressTabClickTimer.current);
    document.body.classList.remove("is-dragging-tool-tab");
  }, []);

  useEffect(() => {
    if (active) return;
    clearTabDrag();
    setAddMenuOpen(false);
  }, [active, clearTabDrag]);

  useLayoutEffect(() => {
    if (!addMenuOpen) return;

    const header = tabHeader.current;
    const trigger = addMenuTrigger.current;
    const menu = addMenu.current;
    if (!header || !trigger || !menu) return;

    const updatePosition = () => {
      const headerRect = header.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      const edgePadding = 8;
      const preferredLeft = triggerRect.left - headerRect.left;
      const maxLeft = Math.max(edgePadding, headerRect.width - menu.offsetWidth - edgePadding);
      const nextLeft = Math.min(maxLeft, Math.max(edgePadding, preferredLeft));
      setAddMenuLeft((current) => Math.abs(current - nextLeft) < 0.5 ? current : nextLeft);
    };

    updatePosition();
    const resizeObserver = new ResizeObserver(updatePosition);
    resizeObserver.observe(header);
    resizeObserver.observe(menu);
    window.addEventListener("resize", updatePosition);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updatePosition);
    };
  }, [addMenuOpen]);

  useEffect(() => {
    if (!addMenuOpen) return;

    const focusFrame = window.requestAnimationFrame(() => {
      if (workspace) addFilesItem.current?.focus();
      else addTerminalItem.current?.focus();
    });
    const handlePointerDown = (event: PointerEvent) => {
      if (
        !(event.target instanceof Node)
        || (
          !addMenuRoot.current?.contains(event.target)
          && !addMenu.current?.contains(event.target)
        )
      ) {
        setAddMenuOpen(false);
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setAddMenuOpen(false);
      window.requestAnimationFrame(() => addMenuTrigger.current?.focus());
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [addMenuOpen, workspace]);

  useEffect(() => {
    if (workspace || !tabsRef.current.some((tab) => tab.type === "files")) return;
    changeState((current) => removeUnavailableFileTabs(current, workspace));
    setAddMenuOpen(false);
  }, [changeState, workspace]);

  const updateTabMeta = useCallback((tabId: string, meta: TerminalTabMeta) => {
    setTabMeta((current) => {
      const existing = current[tabId];
      if (
        existing
        && existing.label === meta.label
        && existing.fullPath === meta.fullPath
        && existing.status === meta.status
      ) {
        return current;
      }
      return { ...current, [tabId]: meta };
    });
  }, []);

  function openTerminal() {
    const id = crypto.randomUUID();
    changeState((current) => ({
      ...current,
      tabs: [...current.tabs, { id, type: "terminal", workingDirectory }],
      activeTabId: id,
    }));
    setAddMenuOpen(false);
  }

  function openFiles() {
    if (!workspace) return;
    const existing = tabs.find((tab) => tab.type === "files");
    if (existing) {
      changeState((current) => ({ ...current, activeTabId: existing.id }));
      setAddMenuOpen(false);
      return;
    }
    const id = crypto.randomUUID();
    changeState((current) => ({
      ...current,
      tabs: [{ id, type: "files" }, ...current.tabs],
      activeTabId: id,
    }));
    setAddMenuOpen(false);
  }

  function selectTab(tabId: string) {
    if (suppressTabClick.current) {
      suppressTabClick.current = false;
      return;
    }
    changeState((current) => current.activeTabId === tabId
      ? current
      : { ...current, activeTabId: tabId });
    setAddMenuOpen(false);
  }

  function closeTab(tabId: string) {
    const closingIndex = tabs.findIndex((tab) => tab.id === tabId);
    if (closingIndex < 0) return;

    const remainingTabs = tabs.filter((tab) => tab.id !== tabId);
    const nextActiveId = activeTabId === tabId
      ? remainingTabs[Math.min(closingIndex, remainingTabs.length - 1)]?.id ?? null
      : activeTabId;

    changeState((current) => ({
      ...current,
      tabs: remainingTabs,
      activeTabId: nextActiveId,
    }));
    setAddMenuOpen(false);
    setTabMeta((current) => {
      const next = { ...current };
      delete next[tabId];
      return next;
    });

    window.requestAnimationFrame(() => {
      if (nextActiveId) {
        document.getElementById(`tool-tab-${nextActiveId}`)?.focus();
      } else {
        addMenuTrigger.current?.focus();
      }
    });
  }

  function handleTabPointerDown(event: ReactPointerEvent<HTMLButtonElement>, tabId: string) {
    if (tabs.length < 2 || event.button !== 0) return;
    const list = tabList.current;
    const element = event.currentTarget.closest<HTMLElement>(".side-panel-tab-item");
    if (!list || !element) return;
    const bounds = element.getBoundingClientRect();
    const listStyles = window.getComputedStyle(list);
    const gap = Number.parseFloat(listStyles.columnGap) || 0;
    const initialIndex = tabsRef.current.findIndex((tab) => tab.id === tabId);
    event.stopPropagation();
    tabPointerDrag.current = {
      tabId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      pointerX: event.clientX,
      grabOffsetX: event.clientX - bounds.left,
      offsetX: 0,
      initialIndex,
      previewIndex: initialIndex,
      shiftDistance: bounds.width + gap,
      maxScrollLeft: Math.max(0, list.scrollWidth - list.clientWidth),
      dragging: false,
      element,
    };
    list.setPointerCapture(event.pointerId);
  }

  function positionTabDrag(drag: TabPointerDrag) {
    const bounds = drag.element.getBoundingClientRect();
    const baseLeft = bounds.left - drag.offsetX;
    drag.offsetX = drag.pointerX - drag.grabOffsetX - baseLeft;
    drag.element.style.setProperty("--tool-tab-drag-x", `${drag.offsetX}px`);
  }

  function scheduleTabDragPosition(drag: TabPointerDrag, pointerX: number) {
    drag.pointerX = pointerX;
    if (tabDragFrame.current !== null) return;

    tabDragFrame.current = window.requestAnimationFrame(() => {
      tabDragFrame.current = null;
      const current = tabPointerDrag.current;
      if (!current?.dragging) return;
      positionTabDrag(current);
    });
  }

  function clearTabReorderPreview() {
    tabList.current?.querySelectorAll<HTMLElement>(".side-panel-tab-item").forEach((item) => {
      item.style.removeProperty("--tool-tab-reorder-x");
    });
  }

  function updateTabReorderPreview(drag: TabPointerDrag, targetIndex: number) {
    if (targetIndex === drag.previewIndex) return;

    const indexById = new Map(tabsRef.current.map((tab, index) => [tab.id, index]));
    const list = tabList.current;
    list?.querySelectorAll<HTMLElement>(".side-panel-tab-item[data-tool-tab-id]").forEach((item) => {
      const tabId = item.dataset.toolTabId;
      const index = tabId ? indexById.get(tabId) : undefined;
      if (index === undefined || tabId === drag.tabId) return;

      let shift = 0;
      if (targetIndex > drag.initialIndex && index > drag.initialIndex && index <= targetIndex) {
        shift = -drag.shiftDistance;
      } else if (targetIndex < drag.initialIndex && index >= targetIndex && index < drag.initialIndex) {
        shift = drag.shiftDistance;
      }

      if (shift === 0) {
        item.style.removeProperty("--tool-tab-reorder-x");
      } else {
        item.style.setProperty("--tool-tab-reorder-x", `${shift}px`);
      }
    });
    drag.previewIndex = targetIndex;
  }

  function handleTabPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = tabPointerDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (!drag.dragging) {
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance < TAB_DRAG_THRESHOLD) return;
      drag.dragging = true;
      setDraggedTabId(drag.tabId);
      setAddMenuOpen(false);
      document.body.classList.add("is-dragging-tool-tab");
    }

    event.preventDefault();
    event.stopPropagation();
    scheduleTabDragPosition(drag, event.clientX);

    const list = tabList.current;
    if (!list) return;
    const bounds = list.getBoundingClientRect();

    const edgeOffset = event.clientX < bounds.left
      ? event.clientX - bounds.left
      : event.clientX > bounds.right
        ? event.clientX - bounds.right
        : 0;
    if (edgeOffset !== 0 && drag.maxScrollLeft > 0) {
      const scrollStep = Math.sign(edgeOffset) * Math.min(
        TAB_AUTO_SCROLL_MAX_STEP,
        Math.max(1, Math.ceil(Math.abs(edgeOffset) / 16)),
      );
      list.scrollLeft = Math.max(0, Math.min(drag.maxScrollLeft, list.scrollLeft + scrollStep));
    }

    const draggedCenter = event.clientX - drag.grabOffsetX + drag.element.offsetWidth / 2;
    const currentTabs = tabsRef.current;
    const previewIndex = tabReorderIndexAt(list, currentTabs, draggedCenter, drag.tabId);
    updateTabReorderPreview(drag, previewIndex);
  }

  function finishTabPointerDrag(event: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    const drag = tabPointerDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (!cancelled && !drag.dragging) selectTab(drag.tabId);

    if (!cancelled) {
      if (drag.dragging) {
        event.preventDefault();
        const currentTabs = tabsRef.current;
        const finalIndex = drag.previewIndex;
        if (finalIndex !== drag.initialIndex) {
          const list = tabList.current;
          list?.setAttribute("data-reorder-committing", "true");
          clearTabReorderPreview();
          drag.element.style.removeProperty("--tool-tab-drag-x");
          const nextTabs = reorderTab(currentTabs, drag.tabId, finalIndex);
          tabsRef.current = nextTabs;
          flushSync(() => changeState((current) => ({ ...current, tabs: nextTabs })));
          window.requestAnimationFrame(() => list?.removeAttribute("data-reorder-committing"));
          setTabOrderAnnouncement(`Moved tab to position ${finalIndex + 1} of ${nextTabs.length}.`);
        }
      }
      suppressTabClick.current = true;
      if (suppressTabClickTimer.current !== null) window.clearTimeout(suppressTabClickTimer.current);
      suppressTabClickTimer.current = window.setTimeout(() => {
        suppressTabClick.current = false;
        suppressTabClickTimer.current = null;
      }, 0);
    }

    clearTabDrag();
    if (drag.dragging && !cancelled) {
      window.requestAnimationFrame(() => document.getElementById(`tool-tab-${drag.tabId}`)?.focus());
    }
  }

  function moveTabWithKeyboard(tabId: string, direction: -1 | 1) {
    const currentIndex = tabs.findIndex((tab) => tab.id === tabId);
    const nextIndex = Math.max(0, Math.min(tabs.length - 1, currentIndex + direction));
    if (currentIndex < 0 || nextIndex === currentIndex) return;

    const nextTabs = [...tabs];
    const [tab] = nextTabs.splice(currentIndex, 1);
    if (!tab) return;
    nextTabs.splice(nextIndex, 0, tab);
    tabsRef.current = nextTabs;
    changeState((current) => ({ ...current, tabs: nextTabs }));
    setTabOrderAnnouncement(`Moved tab to position ${nextIndex + 1} of ${nextTabs.length}.`);
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, tabId: string) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    if (event.altKey) {
      moveTabWithKeyboard(tabId, event.key === "ArrowRight" ? 1 : -1);
      return;
    }
    const currentIndex = tabs.findIndex((tab) => tab.id === tabId);
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextTab = tabs[(currentIndex + direction + tabs.length) % tabs.length];
    if (!nextTab) return;
    selectTab(nextTab.id);
    window.requestAnimationFrame(() => document.getElementById(`tool-tab-${nextTab.id}`)?.focus());
  }

  return (
    <aside
      id={active ? "tools-panel" : undefined}
      className="right-side-panel"
      aria-label="Tools"
      hidden={!active}
    >
      <div className="side-panel-tabs" ref={tabHeader} data-tauri-drag-region="deep">
        <div className="side-panel-tab-rail">
          <div
            className="side-panel-tab-list"
            ref={tabList}
            role="tablist"
            aria-label="Open tools"
            data-drag-active={draggedTabId !== null}
            onPointerCancel={(event) => finishTabPointerDrag(event, true)}
            onPointerMove={handleTabPointerMove}
            onPointerUp={finishTabPointerDrag}
          >
            {tabs.map((tab) => {
              const meta = tab.type === "files"
                ? {
                    label: "Files",
                    fullPath: workingDirectory,
                    status: undefined,
                  }
                : tabMeta[tab.id] ?? {
                    label: compactPath(tab.workingDirectory),
                    fullPath: tab.workingDirectory,
                    status: "starting" as const,
                  };
              const selected = activeTabId === tab.id;
              const dragging = draggedTabId === tab.id;
              return (
                <div
                  className="side-panel-tab-item"
                  data-selected={selected}
                  data-dragging={dragging}
                  data-tool-tab-id={tab.id}
                  key={tab.id}
                  role="presentation"
                >
                  <button
                    id={`tool-tab-${tab.id}`}
                    className="side-panel-tab"
                    data-status={meta.status}
                    data-reorderable={tabs.length > 1}
                    type="button"
                    role="tab"
                    aria-controls={`tool-content-${tab.id}`}
                    aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                    aria-roledescription="draggable tab"
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    title={`${meta.fullPath ?? meta.label}\nDrag to reorder · Alt+←/→ to move`}
                    onClick={() => selectTab(tab.id)}
                    onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
                    onPointerDown={(event) => handleTabPointerDown(event, tab.id)}
                  >
                    <PanelIcon name={tab.type === "files" ? "files" : "terminal"} size={14} />
                    <span>{meta.label}</span>
                  </button>
                  <button
                    className="side-panel-tab-close"
                    type="button"
                    aria-label={`Close ${meta.label}`}
                    tabIndex={selected ? 0 : -1}
                    title={`Close ${meta.label}`}
                    onClick={() => closeTab(tab.id)}
                  >
                    <PanelIcon name="x" size={13} />
                  </button>
                </div>
              );
            })}
          </div>
          <span className="side-panel-tab-announcer" aria-live="polite">{tabOrderAnnouncement}</span>
          <div className="side-panel-add-menu-root" ref={addMenuRoot}>
            <button
              className={`side-panel-add ${addMenuOpen ? "active" : ""}`}
              ref={addMenuTrigger}
              type="button"
              aria-label="Add tool tab"
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
              title="Add tool tab"
              onClick={() => setAddMenuOpen((current) => !current)}
            >
              <PanelIcon name="plus" />
            </button>
          </div>
        </div>
        {addMenuOpen && (
          <div
            className="side-panel-add-menu"
            ref={addMenu}
            role="menu"
            aria-label="Add tool tab"
            style={{ left: addMenuLeft }}
          >
            <button
              ref={addFilesItem}
              type="button"
              role="menuitem"
              disabled={!workspace}
              title={workspace ? undefined : "Choose a working directory to browse files"}
              onClick={openFiles}
            >
              <PanelIcon name="files" size={14} />
              <span>Files</span>
            </button>
            <button ref={addTerminalItem} type="button" role="menuitem" onClick={openTerminal}>
              <PanelIcon name="terminal" size={14} />
              <span>Terminal</span>
            </button>
          </div>
        )}
      </div>

      <div className="side-panel-content">
        {tabs.length === 0 && (
          <div className="side-panel-empty" role="status">
            <span className="side-panel-empty-icon"><PanelIcon name="terminal" size={17} /></span>
            <strong>No open tools</strong>
            <p>Use + to browse files or open a terminal.</p>
          </div>
        )}
        {tabs.map((tab) => tab.type === "files" ? (
          <div
            id={`tool-content-${tab.id}`}
            className="file-tool-stage"
            role="tabpanel"
            aria-labelledby={`tool-tab-${tab.id}`}
            hidden={activeTabId !== tab.id}
            key={tab.id}
          >
            <FileExplorer
              active={open && activeTabId === tab.id}
              sessionId={sessionId}
              workspace={workspace}
              workingDirectory={workingDirectory}
              attachmentDisabled={attachmentDisabled}
              onAttach={onAttach}
            />
          </div>
        ) : (
          <TerminalToolView
            key={tab.id}
            tab={tab}
            active={active && activeTabId === tab.id}
            appearance={appearance}
            panelOpen={open}
            onMetaChange={updateTabMeta}
          />
        ))}
      </div>
    </aside>
  );
}
