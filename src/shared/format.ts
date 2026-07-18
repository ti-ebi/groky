export function formatFileSize(bytes: number) {
  const safeBytes = Math.max(0, bytes);
  if (safeBytes < 1_024) return `${safeBytes} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = safeBytes / 1_024;
  let unitIndex = 0;

  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }

  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatTokenCount(value: number) {
  return new Intl.NumberFormat("en", {
    notation: value >= 10_000 ? "compact" : "standard",
  }).format(value);
}

export function cleanVersion(version: string | null) {
  return version?.replace(/^grok\s+/, "") ?? "not detected";
}
