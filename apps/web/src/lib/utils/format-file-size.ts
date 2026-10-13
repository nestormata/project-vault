const KB = 1024
const MB = KB * 1024

/** Story 62-4 AC-4: deterministic, non-localised size text (`N B`, `N.N KB`, `N.N MB`). */
export function formatFileSize(bytes: number): string {
  if (bytes < KB) return `${bytes} B`
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`
  return `${(bytes / MB).toFixed(1)} MB`
}
