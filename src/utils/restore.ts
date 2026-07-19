import { existsSync, chmodSync, mkdirSync, copyFileSync } from "node:fs"
import { checkPathExists } from "./fs"
import { hashFile } from "./hash"
import { warn } from "./log"
import type { ManifestEntry } from "./store-types"

export type RestoreStatus = "restored" | "cached" | "error"

/**
 * Restore a single file from an extracted archive to its final location.
 * Checks if local file already matches (by hash) before copying.
 */
export async function restoreSingleFile(
  absolutePath: string,
  entry: ManifestEntry,
  tmpDir: string,
): Promise<RestoreStatus> {
  // Find the file in the extracted archive
  const extractedPath = `${tmpDir}${absolutePath}`
  let sourcePath: string | null = null

  if (existsSync(extractedPath)) {
    sourcePath = extractedPath
  } else {
    const stripped = absolutePath.startsWith("/")
      ? absolutePath.slice(1)
      : absolutePath
    const altPath = `${tmpDir}/${stripped}`
    if (existsSync(altPath)) {
      sourcePath = altPath
    }
  }

  if (!sourcePath) return "error"

  // Check if local already matches
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
    } catch {
      // Can't hash — proceed with restore
    }
  }

  // Copy to final location
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
