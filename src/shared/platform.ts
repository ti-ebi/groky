export function isDesktopHost() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function isMacOS() {
  if (typeof navigator === "undefined") return false;
  return /Macintosh|Mac OS X|MacIntel/.test(`${navigator.userAgent} ${navigator.platform}`);
}

export function usesOverlayTitlebar() {
  return isDesktopHost() && isMacOS();
}
