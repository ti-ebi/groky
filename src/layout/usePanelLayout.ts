import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

const SIDEBAR_WIDTH_KEY = "groky.sidebar.width";
const SIDEBAR_COLLAPSED_KEY = "groky.sidebar.collapsed";
const SIDE_PANEL_WIDTH_KEY = "groky.side-panel.width";

export const DEFAULT_SIDEBAR_WIDTH = 258;
export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 420;
export const MIN_SIDE_PANEL_WIDTH = 340;
export const MAX_SIDE_PANEL_WIDTH = 760;

const FALLBACK_SIDE_PANEL_WIDTH = 480;
const DEFAULT_SIDE_PANEL_WIDTH_RATIO = 0.42;

function clamp(width: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, width));
}

function clampSidebarWidth(width: number) {
  return clamp(width, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
}

function clampSidePanelWidth(width: number) {
  return clamp(width, MIN_SIDE_PANEL_WIDTH, MAX_SIDE_PANEL_WIDTH);
}

export function defaultSidePanelWidth() {
  const viewportWidth = typeof window === "undefined" ? 0 : window.innerWidth;
  return clampSidePanelWidth(
    viewportWidth > 0
      ? Math.round(viewportWidth * DEFAULT_SIDE_PANEL_WIDTH_RATIO)
      : FALLBACK_SIDE_PANEL_WIDTH,
  );
}

export function initialSidePanelWidth() {
  return storedNumber(SIDE_PANEL_WIDTH_KEY, defaultSidePanelWidth, clampSidePanelWidth);
}

function storedNumber(key: string, fallback: () => number, normalize: (value: number) => number) {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? normalize(value) : fallback();
  } catch {
    return fallback();
  }
}

function storedBoolean(key: string) {
  try {
    return window.localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function persist(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Layout persistence is optional when storage is unavailable.
  }
}

function keyboardResizeWidth(
  event: KeyboardEvent<HTMLDivElement>,
  currentWidth: number,
  minimum: number,
  maximum: number,
  leftArrowDirection: -1 | 1,
) {
  const step = event.shiftKey ? 32 : 12;
  switch (event.key) {
    case "ArrowLeft":
      return currentWidth + leftArrowDirection * step;
    case "ArrowRight":
      return currentWidth - leftArrowDirection * step;
    case "Home":
      return minimum;
    case "End":
      return maximum;
    default:
      return null;
  }
}

interface PanelLayoutOptions {
  onSidebarToggle?: () => void;
  sidePanelOpen: boolean;
  sidePanelWidth: number;
  onSidePanelToggle: () => void;
  onSidePanelWidthChange: (width: number) => void;
}

export function usePanelLayout({
  onSidebarToggle,
  sidePanelOpen,
  sidePanelWidth,
  onSidePanelToggle,
  onSidePanelWidthChange,
}: PanelLayoutOptions) {
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    storedNumber(SIDEBAR_WIDTH_KEY, () => DEFAULT_SIDEBAR_WIDTH, clampSidebarWidth)
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    storedBoolean(SIDEBAR_COLLAPSED_KEY)
  );
  const sidebarResizeStart = useRef<{ pointerX: number; width: number } | null>(null);
  const sidePanelResizeStart = useRef<{ pointerX: number; width: number } | null>(null);
  const sidebarToggleCallback = useRef(onSidebarToggle);
  const sidePanelToggleCallback = useRef(onSidePanelToggle);
  const sidePanelWidthChangeCallback = useRef(onSidePanelWidthChange);

  useLayoutEffect(() => {
    sidebarToggleCallback.current = onSidebarToggle;
    sidePanelToggleCallback.current = onSidePanelToggle;
    sidePanelWidthChangeCallback.current = onSidePanelWidthChange;
  }, [onSidebarToggle, onSidePanelToggle, onSidePanelWidthChange]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((current) => !current);
    sidebarToggleCallback.current?.();
  }, []);

  const toggleSidePanel = useCallback(() => {
    sidePanelToggleCallback.current();
  }, []);

  useEffect(() => persist(SIDEBAR_WIDTH_KEY, String(sidebarWidth)), [sidebarWidth]);
  useEffect(() => persist(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed)), [sidebarCollapsed]);
  useEffect(() => persist(SIDE_PANEL_WIDTH_KEY, String(sidePanelWidth)), [sidePanelWidth]);

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "b") return;
      event.preventDefault();
      toggleSidebar();
    };

    window.addEventListener("keydown", handleShortcut);
    return () => {
      window.removeEventListener("keydown", handleShortcut);
      document.body.classList.remove("is-resizing-sidebar");
    };
  }, [toggleSidebar]);

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "j") return;
      event.preventDefault();
      toggleSidePanel();
    };

    window.addEventListener("keydown", handleShortcut);
    return () => {
      window.removeEventListener("keydown", handleShortcut);
      document.body.classList.remove("is-resizing-side-panel");
    };
  }, [toggleSidePanel]);

  function startSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || sidebarCollapsed) return;
    event.preventDefault();
    sidebarResizeStart.current = { pointerX: event.clientX, width: sidebarWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing-sidebar");
  }

  function resizeSidebar(event: ReactPointerEvent<HTMLDivElement>) {
    const start = sidebarResizeStart.current;
    if (!start) return;
    setSidebarWidth(clampSidebarWidth(start.width + event.clientX - start.pointerX));
  }

  function finishSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!sidebarResizeStart.current) return;
    sidebarResizeStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("is-resizing-sidebar");
  }

  function resizeSidebarWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    const nextWidth = keyboardResizeWidth(
      event,
      sidebarWidth,
      MIN_SIDEBAR_WIDTH,
      MAX_SIDEBAR_WIDTH,
      -1,
    );
    if (nextWidth === null) return;
    event.preventDefault();
    setSidebarWidth(clampSidebarWidth(nextWidth));
  }

  function startSidePanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !sidePanelOpen) return;
    event.preventDefault();
    event.currentTarget.focus();
    sidePanelResizeStart.current = { pointerX: event.clientX, width: sidePanelWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing-side-panel");
  }

  function resizeSidePanel(event: ReactPointerEvent<HTMLDivElement>) {
    const start = sidePanelResizeStart.current;
    if (!start) return;
    sidePanelWidthChangeCallback.current(
      clampSidePanelWidth(start.width - event.clientX + start.pointerX),
    );
  }

  function finishSidePanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!sidePanelResizeStart.current) return;
    sidePanelResizeStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("is-resizing-side-panel");
  }

  function resizeSidePanelWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    const nextWidth = keyboardResizeWidth(
      event,
      sidePanelWidth,
      MIN_SIDE_PANEL_WIDTH,
      MAX_SIDE_PANEL_WIDTH,
      1,
    );
    if (nextWidth === null) return;
    event.preventDefault();
    sidePanelWidthChangeCallback.current(clampSidePanelWidth(nextWidth));
  }

  return {
    sidebarWidth,
    sidebarCollapsed,
    toggleSidebar,
    toggleSidePanel,
    resetSidebarWidth: () => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH),
    resetSidePanelWidth: () => sidePanelWidthChangeCallback.current(defaultSidePanelWidth()),
    startSidebarResize,
    resizeSidebar,
    finishSidebarResize,
    resizeSidebarWithKeyboard,
    startSidePanelResize,
    resizeSidePanel,
    finishSidePanelResize,
    resizeSidePanelWithKeyboard,
  };
}
