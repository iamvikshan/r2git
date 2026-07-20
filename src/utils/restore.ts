import {
  chmodSync,
  mkdirSync,
  copyFileSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs"
import { join } from "node:path"
import { archiveEntryPath } from "./archive"
import { checkPathExists } from "./fs"
import { hashFile } from "./hash"
import { warn } from "./log"
import type { ManifestEntry } from "./store-types"

export type RestoreStatus = "restored" | "cached" | "error"

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
  const stripped = absolutePath.startsWith("/")
    ? absolutePath.slice(1)
    : absolutePath
  const candidates = [
    join(tmpDir, archiveEntryPath(originalPath)),
    `${tmpDir}${absolutePath}`,
    join(tmpDir, stripped),
  ]
  let sourcePath: string | undefined
  for (const candidate of candidates) {
    try {
      lstatSync(candidate)
      sourcePath = candidate
      break
    } catch {
      continue
    }
  }

  if (!sourcePath) return "error"

  if (entry.type === "symlink-tar") {
    try {
      const sourceStat = lstatSync(sourcePath)
      const linkTarget = sourceStat.isSymbolicLink()
        ? readlinkSync(sourcePath)
        : readFileSync(sourcePath, "utf8")
      try {
        unlinkSync(absolutePath)
      } catch {}
      const dir = absolutePath.substring(0, absolutePath.lastIndexOf("/"))
      mkdirSync(dir, { recursive: true })
      symlinkSync(linkTarget, absolutePath)
      return "restored"
    } catch (e) {
      warn(
        `Could not restore symlink ${absolutePath}: ${e instanceof Error ? e.message : String(e)}`,
        "restore",
      )
      return "error"
    }
  }

  const exists = await checkPathExists(absolutePath)
  if (exists) {
    try {
      const localHash = await hashFile(absolutePath)
      if (localHash === entry.hash) {
        try {
          chmodSync(absolutePath, parseInt(entry.mode, 8))
        } catch {}
        return "cached"
      }
    } catch {}
  }

  const dir = absolutePath.substring(0, absolutePath.lastIndexOf("/"))
  mkdirSync(dir, { recursive: true })
  copyFileSync(sourcePath, absolutePath)
  try {
    chmodSync(absolutePath, parseInt(entry.mode, 8))
  } catch {
    warn(`Could not set permissions on ${absolutePath}`, "restore")
  }

  return "restored"
}
