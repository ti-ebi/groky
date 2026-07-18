export function pathBaseName(path: string | null) {
  if (!path) return null;

  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export function workspaceName(path: string | null, fallback = "No working directory") {
  return pathBaseName(path) ?? fallback;
}
