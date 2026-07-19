import { lstatSync, statSync } from "node:fs"
import { Glob } from "bun"

export function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "/root"
}

export function joinPaths(a: string, b: string): string {
  const cleanA = a.endsWith("/") ? a.slice(0, -1) : a
  const cleanB = b.startsWith("/") ? b.slice(1) : b
  return `${cleanA}/${cleanB}`
}

export type PathContext = {
  cwd: string
  home: string
  project?: string
}

/**
 * Check if a path is exactly baseDir or a descendant of it,
 * preventing sibling directory false matches (e.g. "/home/user" vs "/home/user2").
 * Returns true only if path === baseDir or path starts with baseDir + separator.
 */
export function isPathUnderBase(path: string, baseDir: string): boolean {
  if (path === baseDir) return true
  // Normalize to avoid trailing slashes
  const normalizedBase = baseDir.endsWith("/") ? baseDir.slice(0, -1) : baseDir
  const normalizedPath = path.endsWith("/") ? path.slice(0, -1) : path
  if (normalizedPath === normalizedBase) return true
  // Check for path separator boundary
  return normalizedPath.startsWith(normalizedBase + "/")
}

/**
 * Resolve a path variable string to an absolute path.
 *
 * Supported variables:
 *   {cwd}         → process.cwd()
 *   {home}        → home directory
 *   ~             → home directory (shorthand)
 *   {project}     → project name from config
 *   {xdg_config}  → $XDG_CONFIG_HOME or ~/.config
 *   {xdg_data}    → $XDG_DATA_HOME or ~/.local/share
 *   {xdg_cache}   → $XDG_CACHE_HOME or ~/.cache
 *   {tmp}         → OS temp directory
 *
 * Absolute paths (starting with /) pass through unchanged.
 * Relative paths are resolved against cwd.
 */
function isAbsolutePath(p: string): boolean {
  if (p.startsWith("/")) return true
  if (p.length >= 3 && p[1] === ":" && (p[2] === "\\" || p[2] === "/"))
    return true
  if (p.startsWith("\\\\")) return true
  return false
}

export function resolvePath(input: string, ctx: PathContext): string {
  let resolved = input

  // ~ → home
  if (resolved.startsWith("~")) {
    resolved = resolved.replace("~", ctx.home)
  }

  // Variable substitution (order matters — do longest matches first)
  resolved = resolved.replace(
    /\{xdg_config\}/g,
    process.env.XDG_CONFIG_HOME ?? `${ctx.home}/.config`,
  )
  resolved = resolved.replace(
    /\{xdg_data\}/g,
    process.env.XDG_DATA_HOME ?? `${ctx.home}/.local/share`,
  )
  resolved = resolved.replace(
    /\{xdg_cache\}/g,
    process.env.XDG_CACHE_HOME ?? `${ctx.home}/.cache`,
  )
  resolved = resolved.replace(
    /\{tmp\}/g,
    process.env.TMPDIR ?? process.env.TEMP ?? "/tmp",
  )
  resolved = resolved.replace(/\{home\}/g, ctx.home)
  resolved = resolved.replace(/\{cwd\}/g, ctx.cwd)
  if (ctx.project) {
    resolved = resolved.replace(/\{project\}/g, ctx.project)
  }

  // Absolute path → pass through
  if (isAbsolutePath(resolved)) {
    return resolved
  }

  // Relative path → resolve against cwd
  return joinPaths(ctx.cwd, resolved)
}

/**
 * Build a PathContext from current environment.
 */
export function buildPathContext(project?: string): PathContext {
  return {
    cwd: process.cwd(),
    home: homeDir(),
    ...(project !== undefined && { project }),
  }
}

/**
 * Resolve an array of paths using the given context.
 * Returns [resolved, relative] where relative has leading / stripped (for tar).
 */
export function resolvePaths(
  paths: string[],
  ctx: PathContext,
): Array<{ original: string; absolute: string; relative: string }> {
  return paths.map(p => {
    const absolute = resolvePath(p, ctx)
    const relative = absolute.startsWith("/") ? absolute.slice(1) : absolute
    return { original: p, absolute, relative }
  })
}

/**
 * Check if a path exists. Accepts absolute paths directly.
 * Checks both files and directories.
 */
export async function checkPathExists(absolutePath: string): Promise<boolean> {
  try {
    // Check if it's a file first
    if (await Bun.file(absolutePath).exists()) {
      return true
    }
    // Check if it's a directory
    return isDirectory(absolutePath)
  } catch {
    return false
  }
}

/**
 * Check if a path is a symlink (works for dangling symlinks too).
 */
export function isSymlink(absolutePath: string): boolean {
  try {
    return lstatSync(absolutePath).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Check if a path is a directory (follows symlinks).
 */
export function isDirectory(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isDirectory()
  } catch {
    return false
  }
}

/**
 * Get file size in bytes. Returns null if file doesn't exist.
 */
export async function getFileSize(
  absolutePath: string,
): Promise<number | null> {
  try {
    const file = Bun.file(absolutePath)
    if (await file.exists()) {
      return file.size
    }
    return null
  } catch {
    return null
  }
}

export async function getMaxMTime(path: string): Promise<number | null> {
  try {
    const file = Bun.file(path)
    if (await file.exists()) {
      return file.lastModified
    }
    // If it's a directory
    const glob = new Glob("**/*")
    let max = 0
    let hasFiles = false
    for (const entry of glob.scanSync({
      cwd: path,
      absolute: true,
      onlyFiles: true,
    })) {
      hasFiles = true
      const f = Bun.file(entry)
      if (f.lastModified > max) {
        max = f.lastModified
      }
    }
    return hasFiles ? max : null
  } catch {
    return null
  }
}

export async function copyToClipboard(text: string): Promise<boolean> {
  const platform = process.platform
  try {
    let cmd: string[] = []
    if (platform === "darwin") {
      cmd = ["pbcopy"]
    } else if (platform === "linux") {
      if (Bun.which("wl-copy")) {
        cmd = ["wl-copy"]
      } else if (Bun.which("xclip")) {
        cmd = ["xclip", "-selection", "clipboard"]
      } else if (Bun.which("xsel")) {
        cmd = ["xsel", "--clipboard", "--input"]
      } else {
        return false
      }
    } else if (platform === "win32") {
      cmd = ["clip"]
    } else {
      return false
    }

    const proc = Bun.spawn(cmd, { stdin: "pipe" })
    await proc.stdin.write(text)
    await proc.stdin.end()
    await proc.exited
    return proc.exitCode === 0
  } catch {
    return false
  }
}
