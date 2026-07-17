export const isTauri = () => "__TAURI_INTERNALS__" in window;

export const isMacOS = () => /Macintosh|Mac OS X|MacIntel/.test(`${navigator.userAgent} ${navigator.platform}`);

export const usesOverlayTitlebar = () => isTauri() && isMacOS();

export function cleanVersion(version: string | null) {
  return version?.replace(/^grok\s+/, "") ?? "not detected";
}
