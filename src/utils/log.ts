export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: "\x1b[90mDBG\x1b[0m",
  info: "\x1b[34mINF\x1b[0m",
  warn: "\x1b[33mWRN\x1b[0m",
  error: "\x1b[31mERR\x1b[0m",
}

let _minLevel: LogLevel = "info"

export function setLogLevel(level: LogLevel): void {
  _minLevel = level
}

export function getLogLevel(): LogLevel {
  return _minLevel
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[_minLevel]
}

export function log(level: LogLevel, message: string, context?: string): void {
  if (!shouldLog(level)) return
  const tag = LEVEL_LABELS[level]
  const ctx = context ? ` \x1b[90m[${context}]\x1b[0m` : ""
  if (level === "error") {
    console.error(`${tag}${ctx} ${message}`)
  } else {
    console.log(`${tag}${ctx} ${message}`)
  }
}

export function debug(message: string, context?: string): void {
  log("debug", message, context)
}

export function info(message: string, context?: string): void {
  log("info", message, context)
}

export function warn(message: string, context?: string): void {
  log("warn", message, context)
}

export function error(message: string, context?: string): void {
  log("error", message, context)
}

// --- Path-level progress reporting ---

export type PathResult = {
  path: string
  status: "ok" | "skipped" | "error"
  reason?: string
  size?: number
}

export function printPathResult(r: PathResult): void {
  // Respect quiet mode - only show errors
  if (!shouldLog("info") && r.status !== "error") return

  switch (r.status) {
    case "ok": {
      const size = r.size !== undefined ? ` (${formatSize(r.size)})` : ""
      console.log(`  \x1b[32m✔\x1b[0m ${r.path}${size}`)
      break
    }
    case "skipped":
      console.log(
        `  \x1b[33m⚠\x1b[0m ${r.path} \x1b[90m(${r.reason ?? "skipped"})\x1b[0m`,
      )
      break
    case "error":
      console.log(
        `  \x1b[31m✖\x1b[0m ${r.path} \x1b[90m(${r.reason ?? "error"})\x1b[0m`,
      )
      break
  }
}

export function printPathSummary(results: PathResult[]): void {
  // Respect quiet mode - only show summary if logging is enabled
  if (!shouldLog("info")) return

  const ok = results.filter(r => r.status === "ok")
  const skipped = results.filter(r => r.status === "skipped")
  const errors = results.filter(r => r.status === "error")
  const totalSize = ok.reduce((sum, r) => sum + (r.size ?? 0), 0)

  console.log("")
  const parts: string[] = []
  if (ok.length > 0) parts.push(`\x1b[32m${ok.length} ready\x1b[0m`)
  if (skipped.length > 0) parts.push(`\x1b[33m${skipped.length} skipped\x1b[0m`)
  if (errors.length > 0) parts.push(`\x1b[31m${errors.length} errors\x1b[0m`)
  console.log(`  Summary: ${parts.join(", ")} — ${formatSize(totalSize)} total`)
  if (skipped.length > 0) {
    for (const r of skipped) {
      console.log(`    \x1b[33m⚠\x1b[0m ${r.path}: ${r.reason}`)
    }
  }
  if (errors.length > 0) {
    for (const r of errors) {
      console.log(`    \x1b[31m✖\x1b[0m ${r.path}: ${r.reason}`)
    }
  }
  console.log("")
}

export function formatSize(bytes: number): string {
  if (bytes > 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  if (bytes > 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes > 1_000) return `${(bytes / 1_000).toFixed(1)} KB`
  return `${bytes} B`
}
