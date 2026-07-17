export function formatDuration(elapsedMs: number) {
  const safeElapsedMs = Math.max(0, elapsedMs);
  const totalSeconds = Math.floor(safeElapsedMs / 1000);
  if (totalSeconds < 10) return `${(safeElapsedMs / 1000).toFixed(1)}s`;
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${seconds}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

export function formatThoughtDuration(elapsedMs: number) {
  const totalSeconds = Math.max(0, elapsedMs) / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;

  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m${(totalSeconds - minutes * 60).toFixed(0)}s`;
}

export function formatFileSize(bytes: number) {
  const safeBytes = Math.max(0, bytes);
  if (safeBytes < 1024) return `${safeBytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = safeBytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatTokenCount(value: number) {
  return new Intl.NumberFormat("en", { notation: value >= 10_000 ? "compact" : "standard" }).format(value);
}
