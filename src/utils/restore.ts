import {
  chmodSync,
  mkdirSync,
  copyFileSync,
  lstatSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  realpathSync,
} from "node:fs"
import { dirname, join, parse, relative, sep } from "node:path"
import { archiveEntryPath } from "./archive"
import { hashFile, hashBuffer } from "./hash"
import { warn } from "./log"
import type { ManifestEntry } from "./store-types"

export type RestoreStatus = "restored" | "cached" | "error"

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function ensureSafeParentDirectory(absolutePath: string): boolean {
  const directory = dirname(absolutePath)
  const root = parse(directory).root
  const components = relative(root, directory).split(sep).filter(Boolean)
  let currentPath = root

  try {
    for (const component of components) {
      currentPath = join(currentPath, component)
      try {
        const stat = lstatSync(currentPath)
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          warn(
            `Destination path ${absolutePath} has unsafe parent ${currentPath}`,
            "restore",
          )
          return false
        }
      } catch (error) {
        if (!isMissingPathError(error)) throw error
        mkdirSync(currentPath)
        const stat = lstatSync(currentPath)
        if (stat.isSymbolicLink() || !stat.isDirectory()) return false
      }
    }
  } catch (error) {
    warn(
      `Failed to prepare directory ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      "restore",
    )
    return false
  }

  return true
}

function validateArchiveSource(sourcePath: string, tmpDir: string): boolean {
  try {
    const sourceStat = lstatSync(sourcePath)
    const canonicalTmpDir = realpathSync(tmpDir)
    const resolvedSource = realpathSync(sourcePath)
    const isContained =
      resolvedSource === canonicalTmpDir ||
      resolvedSource.startsWith(`${canonicalTmpDir}${sep}`)
    if (isContained && sourceStat.isFile()) return true
    warn(`Archive entry ${sourcePath} is unsafe`, "restore")
  } catch {}
  return false
}

function restoreSymlink(
  originalPath: string,
  absolutePath: string,
  entry: ManifestEntry,
  sourcePath: string,
): RestoreStatus {
  try {
    const linkTarget = readFileSync(sourcePath)
    const actualHash = hashBuffer(linkTarget)
    if (actualHash !== entry.hash) {
      warn(
        `Symlink ${originalPath} hash mismatch: expected ${entry.hash}, got ${actualHash}`,
        "restore",
      )
      return "error"
    }
    if (linkTarget.length !== entry.size) {
      warn(
        `Symlink ${originalPath} size mismatch: expected ${entry.size}, got ${linkTarget.length}`,
        "restore",
      )
      return "error"
    }
    if (!ensureSafeParentDirectory(absolutePath)) return "error"

    try {
      unlinkSync(absolutePath)
    } catch {}
    symlinkSync(linkTarget, absolutePath)
    return "restored"
  } catch (error) {
    warn(
      `Could not restore symlink ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
      "restore",
    )
    return "error"
  }
}

async function validateRegularSource(
  originalPath: string,
  entry: ManifestEntry,
  sourcePath: string,
): Promise<boolean> {
  try {
    const sourceStat = lstatSync(sourcePath)
    if (sourceStat.size !== entry.size) {
      warn(
        `File ${originalPath} size mismatch in archive: expected ${entry.size}, got ${sourceStat.size}`,
        "restore",
      )
      return false
    }

    const sourceHash = await hashFile(sourcePath)
    if (sourceHash === entry.hash) return true
    warn(
      `File ${originalPath} hash mismatch in archive: expected ${entry.hash}, got ${sourceHash}`,
      "restore",
    )
  } catch (error) {
    warn(
      `Failed to validate source file ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
      "restore",
    )
  }
  return false
}

async function isCachedDestination(
  absolutePath: string,
  entry: ManifestEntry,
): Promise<boolean> {
  try {
    const stat = lstatSync(absolutePath)
    if (!stat.isFile() || stat.nlink !== 1) return false
    const localHash = await hashFile(absolutePath)
    if (localHash !== entry.hash) return false
    try {
      chmodSync(absolutePath, parseInt(entry.mode, 8))
    } catch {}
    return true
  } catch {
    return false
  }
}

function removeReplaceableDestination(absolutePath: string): boolean {
  try {
    const stat = lstatSync(absolutePath)
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      warn(`Destination ${absolutePath} is not a regular file`, "restore")
      return false
    }
    unlinkSync(absolutePath)
  } catch (error) {
    if (!isMissingPathError(error)) {
      warn(
        `Could not replace destination ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
        "restore",
      )
      return false
    }
  }
  return true
}

async function restoreRegularFile(
  originalPath: string,
  absolutePath: string,
  entry: ManifestEntry,
  sourcePath: string,
): Promise<RestoreStatus> {
  if (!(await validateRegularSource(originalPath, entry, sourcePath))) {
    return "error"
  }
  if (!ensureSafeParentDirectory(absolutePath)) return "error"
  if (await isCachedDestination(absolutePath, entry)) return "cached"
  if (!removeReplaceableDestination(absolutePath)) return "error"

  copyFileSync(sourcePath, absolutePath)
  try {
    chmodSync(absolutePath, parseInt(entry.mode, 8))
  } catch {
    warn(`Could not set permissions on ${absolutePath}`, "restore")
  }
  return "restored"
}

/**
 * Restore a single file or symlink from an extracted archive.
 * For symlinks, recreates the link at the destination.
 * For regular files, checks hash before copying.
 */
export async function restoreSingleFile(
  originalPath: string,
  absolutePath: string,
  entry: ManifestEntry,
  tmpDir: string,
): Promise<RestoreStatus> {
  const sourcePath = join(tmpDir, archiveEntryPath(entry.hash))
  if (!validateArchiveSource(sourcePath, tmpDir)) return "error"
  if (entry.type === "symlink-tar") {
    return restoreSymlink(originalPath, absolutePath, entry, sourcePath)
  }
  return restoreRegularFile(originalPath, absolutePath, entry, sourcePath)
}
