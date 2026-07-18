export function pathBaseName(path: string | null) {
  if (!path) return null;

  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export function workspaceName(path: string | null, fallback = "No working directory") {
  return pathBaseName(path) ?? fallback;
}

export function compactPath(path: string | null) {
  if (!path) return "Terminal";
  const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  if (!normalized) return "/";

  const homeMatch = normalized.match(/^\/(?:Users|home)\/[^/]+/);
  const displayPath = homeMatch ? `~${normalized.slice(homeMatch[0].length)}` : normalized;
  const prefix = displayPath.startsWith("~/") ? "~/" : displayPath.startsWith("/") ? "/" : "";
  const segments = displayPath.replace(/^~?\//, "").split("/").filter(Boolean);
  if (segments.length <= 2) return displayPath;

  const abbreviatedParents = segments.slice(0, -1).map((segment) => segment[0]).join("/");
  return `${prefix}${abbreviatedParents}/${segments[segments.length - 1]}`;
}
