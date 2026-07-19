import type { Manifest, ManifestEntry, ObjectType } from "./store-types"
import { hashFile, hashBuffer } from "./hash"
import { checkPathExists, isSymlink, isDirectory, getFileSize } from "./fs"
import { lstatSync } from "node:fs"
import picomatch from "picomatch"

import { Glob } from "bun"

/**
 * Get file mode as octal string (e.g. "0644").
 */
function getFileMode(filePath: string): string {
  try {
    const stat = lstatSync(filePath)
    return (stat.mode & 0o7777).toString(8).padStart(4, "0")
  } catch {
    return "0644"
  }
}

/**
 * Get file mtime as ISO string.
 */
function getFileMTime(filePath: string): string {
  try {
    const stat = lstatSync(filePath)
    return new Date(stat.mtimeMs).toISOString()
  } catch {
    return new Date().toISOString()
  }
}

/**
 * Create a tar of a single symlink, preserving the link target.
 * Returns the tar buffer.
 */
export function tarSymlink(filePath: string): Uint8Array {
  const proc = Bun.spawnSync([
    "tar",
    "-cf",
    "-",
    "-C",
    "/",
    "--",
    filePath.slice(1), // strip leading /
  ])
  if (!proc.success) {
    throw new Error(
      `Failed to tar symlink ${filePath}: ${proc.stderr.toString()}`,
    )
  }
  return proc.stdout
}

/**
 * Build a manifest entry for a single file path.
 * Handles regular files and symlinks differently.
 */
export async function buildEntry(
  absolutePath: string,
  entryType?: ObjectType,
): Promise<{ entry: ManifestEntry; objectData: Uint8Array | null } | null> {
  // Check if symlink first, before existence check (to catch dangling symlinks)
  const symlink = isSymlink(absolutePath)

  if (symlink || entryType === "symlink-tar") {
    // Tar the symlink individually (works for dangling symlinks too)
    const tarData = tarSymlink(absolutePath)
    const hash = hashBuffer(tarData)
    const mode = getFileMode(absolutePath)
    const mtime = getFileMTime(absolutePath)
    return {
      entry: {
        hash,
        mode,
        size: tarData.length,
        mtime,
        type: "symlink-tar",
      },
      objectData: tarData,
    }
  }

  // For non-symlinks, check existence
  const exists = await checkPathExists(absolutePath)
  if (!exists) return null

  // Regular file — hash content, data will be read on upload
  const mode = getFileMode(absolutePath)
  const mtime = getFileMTime(absolutePath)
  const size = (await getFileSize(absolutePath)) ?? 0
  const hash = await hashFile(absolutePath)
  return {
    entry: {
      hash,
      mode,
      size,
      mtime,
      type: "file",
    },
    objectData: null, // caller reads the file directly for upload
  }
}

function expandDirectory(
  dirPath: string,
  originalPrefix: string,
  isIgnored: (path: string) => boolean,
): {
  expanded: Array<{ original: string; absolute: string }>
  errors: Array<{ path: string; reason: string }>
} {
  const expanded: Array<{ original: string; absolute: string }> = []
  const errors: Array<{ path: string; reason: string }> = []

  try {
    const glob = new Glob("**/*")
    for (const entry of glob.scanSync({
      cwd: dirPath,
      absolute: true,
      onlyFiles: false,
      dot: true,
    })) {
      try {
        if (lstatSync(entry).isDirectory()) continue
      } catch {
        errors.push({ path: entry, reason: "Failed to determine file type" })
        continue
      }
      const relPath = entry.slice(dirPath.length).replace(/^\//, "")
      const originalPath = `${originalPrefix}/${relPath}`
      if (!isIgnored(originalPath)) {
        expanded.push({ original: originalPath, absolute: entry })
      }
    }
  } catch (e) {
    errors.push({
      path: originalPrefix,
      reason: `Failed to expand directory: ${e instanceof Error ? e.message : String(e)}`,
    })
  }

  return { expanded, errors }
}

/**
 * Build a full manifest from resolved paths.
 * @param ignores - glob patterns to exclude (matched against original paths)
 */
export async function buildManifest(
  paths: Array<{ original: string; absolute: string }>,
  project: string,
  ignores: string[] = [],
): Promise<{
  manifest: Manifest
  errors: Array<{ path: string; reason: string }>
}> {
  const entries: Record<string, ManifestEntry> = {}
  const errors: Array<{ path: string; reason: string }> = []

  const isIgnored =
    ignores.length > 0
      ? picomatch(ignores, { dot: true, matchBase: true })
      : () => false

  const expandedPaths: Array<{ original: string; absolute: string }> = []
  for (const p of paths) {
    const symlink = isSymlink(p.absolute)
    if (symlink) {
      if (!isIgnored(p.original)) expandedPaths.push(p)
      continue
    }

    if (isDirectory(p.absolute)) {
      const result = expandDirectory(p.absolute, p.original, isIgnored)
      expandedPaths.push(...result.expanded)
      errors.push(...result.errors)
    } else {
      if (!isIgnored(p.original)) expandedPaths.push(p)
    }
  }

  for (const p of expandedPaths) {
    try {
      const result = await buildEntry(p.absolute)
      if (!result) {
        errors.push({ path: p.original, reason: "file not found" })
        continue
      }
      entries[p.original] = result.entry
    } catch (e) {
      errors.push({
        path: p.original,
        reason: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return {
    manifest: {
      version: 1,
      timestamp: new Date().toISOString(),
      project,
      archiveKey: "",
      entries,
    },
    errors,
  }
}

/**
 * Diff two manifests. Returns entries that are new, changed, or removed.
 */
export function diffManifests(
  local: Manifest,
  remote: Manifest,
): {
  added: string[]
  changed: string[]
  removed: string[]
  unchanged: string[]
} {
  const added: string[] = []
  const changed: string[] = []
  const removed: string[] = []
  const unchanged: string[] = []

  for (const [path, localEntry] of Object.entries(local.entries)) {
    const remoteEntry = remote.entries[path]
    if (!remoteEntry) {
      added.push(path)
    } else if (
      remoteEntry.hash !== localEntry.hash ||
      remoteEntry.mode !== localEntry.mode ||
      remoteEntry.type !== localEntry.type
    ) {
      changed.push(path)
    } else {
      unchanged.push(path)
    }
  }

  for (const path of Object.keys(remote.entries)) {
    if (!local.entries[path]) {
      removed.push(path)
    }
  }

  return { added, changed, removed, unchanged }
}

/**
 * Serialize a manifest to JSON string.
 */
export function serializeManifest(manifest: Manifest): string {
  return JSON.stringify(manifest, null, 2)
}

/**
 * Deserialize a manifest from JSON string.
 */
export function deserializeManifest(json: string): Manifest {
  return JSON.parse(json) as Manifest
}
