import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { host } from "../host";
import type { TerminalInfo } from "../host/types";
import { isDesktopHost } from "../shared/platform";

export type TerminalStatus = "starting" | "running" | "exited" | "error";

const LIGHT_TERMINAL_THEME = {
  background: "#f7faf9",
  foreground: "#25302c",
  cursor: "#117568",
  cursorAccent: "#f7faf9",
  selectionBackground: "#9cd5c466",
  black: "#17201d",
  red: "#b94736",
  green: "#117568",
  yellow: "#8a6515",
  blue: "#326d9f",
  magenta: "#7a5597",
  cyan: "#17747a",
  white: "#e7eeeb",
  brightBlack: "#71807a",
  brightRed: "#d15d49",
  brightGreen: "#0d8b78",
  brightYellow: "#a77b1c",
  brightBlue: "#3d82bd",
  brightMagenta: "#966ab8",
  brightCyan: "#208b91",
  brightWhite: "#ffffff",
};

const DARK_TERMINAL_THEME = {
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
};

export function TerminalSurface({
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
    const unlisteners: Array<() => void> = [];
    const encoder = new TextEncoder();
    let writeQueue = Promise.resolve();
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
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
      theme: colorScheme.matches ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME,
    });
    const updateTerminalTheme = (event: MediaQueryListEvent) => {
      terminal.options.theme = event.matches ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
    };
    colorScheme.addEventListener("change", updateTerminalTheme);
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
        .then(() => host.terminal.write(terminalId, data))
        .catch(() => undefined);
    };
    const dataSubscription = terminal.onData((data) => enqueueInput(Array.from(encoder.encode(data))));
    const binarySubscription = terminal.onBinary((data) => {
      enqueueInput(Array.from(data, (character) => character.charCodeAt(0) & 0xff));
    });
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      if (!running.current) return;
      void host.terminal.resize(terminalId, cols, rows).catch(() => undefined);
    });

    onInfoChange(null);
    onStatusChange("starting");

    const start = async () => {
      if (startRequested) return;
      startRequested = true;
      if (!isDesktopHost()) {
        onStatusChange("error", "The terminal is available in the Groky desktop app.");
        return;
      }

      try {
        const listeners = await Promise.all([
          host.terminal.onOutput((payload) => {
            if (payload.terminalId === terminalId) terminal.write(Uint8Array.from(payload.data));
          }),
          host.terminal.onExit((payload) => {
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

        const info = await host.terminal.start({
          terminalId,
          workingDirectory,
          cols: Math.max(2, terminal.cols),
          rows: Math.max(2, terminal.rows),
        });
        started = true;
        if (!active) {
          void host.terminal.stop(terminalId).catch(() => undefined);
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
      colorScheme.removeEventListener("change", updateTerminalTheme);
      unlisteners.forEach((unlisten) => unlisten());
      if (started) void host.terminal.stop(terminalId).catch(() => undefined);
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
