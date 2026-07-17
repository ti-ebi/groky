import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./TerminalPanel.css";

interface TerminalInfo {
  terminalId: string;
  workingDirectory: string;
  shell: string;
}

interface TerminalOutputEvent {
  terminalId: string;
  data: number[];
}

interface TerminalExitEvent {
  terminalId: string;
  exitCode: number | null;
  signal: string | null;
}

type TerminalStatus = "starting" | "running" | "exited" | "error";

function isTauri() {
  return "__TAURI_INTERNALS__" in window;
}

function compactPath(path: string | null) {
  if (!path) return "Terminal";
  const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  if (!normalized) return "/";

  const homeMatch = normalized.match(/^\/(?:Users|home)\/[^/]+/);
  const displayPath = homeMatch ? `~${normalized.slice(homeMatch[0].length)}` : normalized;
  const prefix = displayPath.startsWith("~/") ? "~/" : displayPath.startsWith("/") ? "/" : "";
  const segments = displayPath.replace(/^~?\//, "").split("/").filter(Boolean);
  if (segments.length <= 2) return displayPath;
  return `${prefix}${segments.slice(0, -1).map((segment) => segment[0]).join("/")}/${segments[segments.length - 1]}`;
}

function PanelIcon({ name, size = 15 }: { name: "plus" | "terminal" | "x"; size?: number }) {
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
      {name === "terminal" && <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3M13 15h4" /></>}
      {name === "x" && <><path d="m7 7 10 10" /><path d="M17 7 7 17" /></>}
    </svg>
  );
}

function TerminalSurface({
  active,
  panelOpen,
  workingDirectory,
  restartToken,
  onInfoChange,
  onStatusChange,
}: {
  active: boolean;
  panelOpen: boolean;
  workingDirectory: string | null;
  restartToken: number;
  onInfoChange: (info: TerminalInfo | null) => void;
  onStatusChange: (status: TerminalStatus, message?: string) => void;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const terminalInstance = useRef<Terminal | null>(null);
  const panelOpenRef = useRef(panelOpen);
  const requestFit = useRef<(() => void) | null>(null);
  const [renderReady, setRenderReady] = useState(false);

  useLayoutEffect(() => {
    panelOpenRef.current = panelOpen;
    if (!panelOpen) {
      setRenderReady(false);
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => requestFit.current?.());
    return () => window.cancelAnimationFrame(animationFrame);
  }, [panelOpen]);

  useEffect(() => {
    if (!active || !panelOpen || !renderReady) return;
    const animationFrame = window.requestAnimationFrame(() => terminalInstance.current?.focus());
    return () => window.cancelAnimationFrame(animationFrame);
  }, [active, panelOpen, renderReady]);

  useEffect(() => {
    const target = container.current;
    if (!target) return;

    let active = true;
    let started = false;
    let startRequested = false;
    let exited = false;
    let resizeFrame = 0;
    let resizeTimer = 0;
    const terminalId = `terminal-${crypto.randomUUID()}`;
    const running = { current: false };
    const unlisteners: UnlistenFn[] = [];
    const encoder = new TextEncoder();
    let writeQueue = Promise.resolve();
    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 1,
      drawBoldTextInBrightColors: false,
      fontFamily: '"SFMono-Regular", "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      fontWeight: 430,
      fontWeightBold: 650,
      letterSpacing: 0.15,
      lineHeight: 1.22,
      minimumContrastRatio: 4.5,
      scrollback: 5000,
      theme: {
        background: "#0b0f0e",
        foreground: "#d9e3df",
        cursor: "#8fe3c1",
        cursorAccent: "#0b0f0e",
        selectionBackground: "#24544799",
        black: "#111614",
        red: "#ff7e68",
        green: "#8fe3c1",
        yellow: "#e6c56f",
        blue: "#83b8ff",
        magenta: "#c9a0ff",
        cyan: "#72d7dc",
        white: "#d9e3df",
        brightBlack: "#63706b",
        brightRed: "#ff9b89",
        brightGreen: "#b5f1d8",
        brightYellow: "#f2d98f",
        brightBlue: "#a7ceff",
        brightMagenta: "#ddc2ff",
        brightCyan: "#9ae9ec",
        brightWhite: "#f4f8f6",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(target);
    terminalInstance.current = terminal;

    const fit = () => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        if (!active || target.clientWidth === 0 || target.clientHeight === 0) return;
        try {
          const dimensions = fitAddon.proposeDimensions();
          if (!dimensions || dimensions.cols < 20 || dimensions.rows < 2) return;
          if (dimensions.cols !== terminal.cols || dimensions.rows !== terminal.rows) {
            terminal.resize(dimensions.cols, dimensions.rows);
          }
          if (panelOpenRef.current) {
            setRenderReady(true);
            if (!startRequested) void start();
          }
        } catch {
          // xterm can be between layout and disposal while the pane is closing.
        }
      });
    };
    const scheduleFit = () => {
      window.clearTimeout(resizeTimer);
      // The panel animates its width. Fitting on every animation frame makes
      // interactive shells redraw their prompt into scrollback repeatedly.
      resizeTimer = window.setTimeout(fit, 90);
    };
    requestFit.current = scheduleFit;

    const enqueueInput = (data: number[]) => {
      if (!running.current || data.length === 0) return;
      writeQueue = writeQueue
        .then(() => invoke<void>("terminal_write", { terminalId, data }))
        .catch(() => undefined);
    };
    const dataSubscription = terminal.onData((data) => enqueueInput(Array.from(encoder.encode(data))));
    const binarySubscription = terminal.onBinary((data) => {
      enqueueInput(Array.from(data, (character) => character.charCodeAt(0) & 0xff));
    });
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      if (!running.current) return;
      void invoke("terminal_resize", { terminalId, cols, rows }).catch(() => undefined);
    });

    onInfoChange(null);
    onStatusChange("starting");

    const start = async () => {
      if (startRequested) return;
      startRequested = true;
      if (!isTauri()) {
        onStatusChange("error", "The terminal is available in the Groky desktop app.");
        return;
      }

      try {
        const listeners = await Promise.all([
          listen<TerminalOutputEvent>("groky://terminal-output", ({ payload }) => {
            if (payload.terminalId === terminalId) terminal.write(Uint8Array.from(payload.data));
          }),
          listen<TerminalExitEvent>("groky://terminal-exit", ({ payload }) => {
            if (payload.terminalId !== terminalId || !active) return;
            exited = true;
            running.current = false;
            const detail = payload.signal
              ? `Shell stopped (${payload.signal}).`
              : payload.exitCode === null || payload.exitCode === 0
                ? "Shell exited."
                : `Shell exited with code ${payload.exitCode}.`;
            onStatusChange("exited", detail);
          }),
        ]);
        if (!active) {
          listeners.forEach((unlisten) => unlisten());
          return;
        }
        unlisteners.push(...listeners);

        const info = await invoke<TerminalInfo>("terminal_start", {
          terminalId,
          workingDirectory,
          cols: Math.max(2, terminal.cols),
          rows: Math.max(2, terminal.rows),
        });
        started = true;
        if (!active) {
          void invoke("terminal_stop", { terminalId }).catch(() => undefined);
          return;
        }
        onInfoChange(info);
        if (exited) return;
        running.current = true;
        onStatusChange("running");
        terminal.focus();
      } catch (error) {
        if (active) onStatusChange("error", String(error));
      }
    };
    const resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(target);
    scheduleFit();

    return () => {
      active = false;
      running.current = false;
      requestFit.current = null;
      window.clearTimeout(resizeTimer);
      window.cancelAnimationFrame(resizeFrame);
      resizeObserver.disconnect();
      dataSubscription.dispose();
      binarySubscription.dispose();
      resizeSubscription.dispose();
      unlisteners.forEach((unlisten) => unlisten());
      if (started) void invoke("terminal_stop", { terminalId }).catch(() => undefined);
      if (terminalInstance.current === terminal) terminalInstance.current = null;
      terminal.dispose();
    };
  }, [restartToken]);

  return (
    <div
      className="terminal-surface"
      ref={container}
      data-render-ready={renderReady}
      aria-label="Interactive terminal"
    />
  );
}

interface TerminalToolTab {
  id: string;
  workingDirectory: string | null;
}

interface TerminalTabMeta {
  label: string;
  fullPath: string | null;
  status: TerminalStatus;
}

function TerminalToolView({
  tab,
  active,
  panelOpen,
  onMetaChange,
}: {
  tab: TerminalToolTab;
  active: boolean;
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
      id={`terminal-tab-content-${tab.id}`}
      className="terminal-stage"
      role="tabpanel"
      aria-labelledby={`terminal-tool-tab-${tab.id}`}
      hidden={!active}
    >
        <TerminalSurface
          active={active}
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
  open,
  workingDirectory,
}: {
  open: boolean;
  workingDirectory: string | null;
}) {
  const [initialTabId] = useState(() => crypto.randomUUID());
  const tabHeader = useRef<HTMLDivElement | null>(null);
  const addMenuRoot = useRef<HTMLDivElement | null>(null);
  const addMenuTrigger = useRef<HTMLButtonElement | null>(null);
  const addMenu = useRef<HTMLDivElement | null>(null);
  const addTerminalItem = useRef<HTMLButtonElement | null>(null);
  const [tabs, setTabs] = useState<TerminalToolTab[]>(() => [
    { id: initialTabId, workingDirectory },
  ]);
  const [tabMeta, setTabMeta] = useState<Record<string, TerminalTabMeta>>({});
  const [activeTabId, setActiveTabId] = useState<string | null>(initialTabId);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addMenuLeft, setAddMenuLeft] = useState(8);

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

    const focusFrame = window.requestAnimationFrame(() => addTerminalItem.current?.focus());
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
  }, [addMenuOpen]);

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
    setTabs((current) => [...current, { id, workingDirectory }]);
    setActiveTabId(id);
    setAddMenuOpen(false);
  }

  function selectTab(tabId: string) {
    setActiveTabId(tabId);
    setAddMenuOpen(false);
  }

  function closeTab(tabId: string) {
    const closingIndex = tabs.findIndex((tab) => tab.id === tabId);
    if (closingIndex < 0) return;

    const remainingTabs = tabs.filter((tab) => tab.id !== tabId);
    const nextActiveId = activeTabId === tabId
      ? remainingTabs[Math.min(closingIndex, remainingTabs.length - 1)]?.id ?? null
      : activeTabId;

    setTabs(remainingTabs);
    setActiveTabId(nextActiveId);
    setAddMenuOpen(false);
    setTabMeta((current) => {
      const next = { ...current };
      delete next[tabId];
      return next;
    });

    window.requestAnimationFrame(() => {
      if (nextActiveId) {
        document.getElementById(`terminal-tool-tab-${nextActiveId}`)?.focus();
      } else {
        addMenuTrigger.current?.focus();
      }
    });
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, tabId: string) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const currentIndex = tabs.findIndex((tab) => tab.id === tabId);
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextTab = tabs[(currentIndex + direction + tabs.length) % tabs.length];
    if (!nextTab) return;
    selectTab(nextTab.id);
    window.requestAnimationFrame(() => document.getElementById(`terminal-tool-tab-${nextTab.id}`)?.focus());
  }

  return (
    <aside id="tools-panel" className="right-side-panel" aria-label="Tools">
      <div className="side-panel-tabs" ref={tabHeader} data-tauri-drag-region="deep">
        <div className="side-panel-tab-rail">
          <div className="side-panel-tab-list" role="tablist" aria-label="Open tools">
            {tabs.map((tab) => {
              const meta = tabMeta[tab.id] ?? {
                label: compactPath(tab.workingDirectory),
                fullPath: tab.workingDirectory,
                status: "starting" as const,
              };
              const selected = activeTabId === tab.id;
              return (
                <div className="side-panel-tab-item" data-selected={selected} key={tab.id} role="presentation">
                  <button
                    id={`terminal-tool-tab-${tab.id}`}
                    className="side-panel-tab"
                    data-status={meta.status}
                    type="button"
                    role="tab"
                    aria-controls={`terminal-tab-content-${tab.id}`}
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    title={meta.fullPath ?? "Terminal"}
                    onClick={() => selectTab(tab.id)}
                    onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
                  >
                    <PanelIcon name="terminal" size={14} />
                    <span>{meta.label}</span>
                  </button>
                  <button
                    className="side-panel-tab-close"
                    type="button"
                    aria-label={`Close terminal ${meta.label}`}
                    tabIndex={selected ? 0 : -1}
                    title="Close terminal"
                    onClick={() => closeTab(tab.id)}
                  >
                    <PanelIcon name="x" size={13} />
                  </button>
                </div>
              );
            })}
          </div>
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
            <p>Use + to open a terminal.</p>
          </div>
        )}
        {tabs.map((tab) => (
          <TerminalToolView
            key={tab.id}
            tab={tab}
            active={activeTabId === tab.id}
            panelOpen={open}
            onMetaChange={updateTabMeta}
          />
        ))}
      </div>
    </aside>
  );
}
