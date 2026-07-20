import { lstatSync, mkdirSync, readlinkSync } from "node:fs"
import { join } from "node:path"

export function archiveEntryPath(originalPath: string): string {
  return join("entries", Buffer.from(originalPath).toString("base64url"))
}

export async function createArchive(
  paths: Array<{ original: string; absolute: string }>,
): Promise<{
  archive: Uint8Array
  errors: Array<{ path: string; reason: string }>
}> {
  const errors: Array<{ path: string; reason: string }> = []
  const archiveEntries: Record<string, ArrayBuffer | string> = {}

  for (const path of paths) {
    try {
      const stat = lstatSync(path.absolute)
      const entryPath = archiveEntryPath(path.original)

      if (stat.isSymbolicLink()) {
        archiveEntries[entryPath] = readlinkSync(path.absolute)
      } else if (stat.isFile()) {
        archiveEntries[entryPath] = await Bun.file(path.absolute).arrayBuffer()
      } else {
        errors.push({ path: path.original, reason: "Unsupported file type" })
      }
    } catch (e) {
      errors.push({
        path: path.original,
        reason: e instanceof Error ? e.message : String(e),
      })
    }
  }

  if (Object.keys(archiveEntries).length === 0) {
    return { archive: new Uint8Array(0), errors }
  }

  const archive = new Bun.Archive(archiveEntries, { compress: "gzip" })
  return { archive: await archive.bytes(), errors }
}

export function extractArchive(
  archive: ArrayBuffer | Uint8Array,
  targetDir: string,
): { errors: Array<{ path: string; reason: string }> } {
  const errors: Array<{ path: string; reason: string }> = []
  mkdirSync(targetDir, { recursive: true })

  const proc = Bun.spawnSync(["tar", "-xzf", "-", "-C", targetDir], {
    stdin: new Uint8Array(archive),
  })

  if (!proc.success) {
    const stderr = proc.stderr.toString().trim()
    errors.push({ path: targetDir, reason: `Extraction failed: ${stderr}` })
  }

  return { errors }
}
