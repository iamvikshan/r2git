import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

export function archiveEntryPath(originalPath: string): string {
  return join("entries", Buffer.from(originalPath).toString("base64url"))
}

export function createArchive(
  paths: Array<{ original: string; absolute: string }>,
): {
  archive: Uint8Array
  errors: Array<{ path: string; reason: string }>
} {
  const errors: Array<{ path: string; reason: string }> = []
  const tmpDir = mkdtempSync(join(tmpdir(), "r2git-archive-"))
  const stagingDir = join(tmpDir, "payload")
  let stagedFiles = 0

  try {
    mkdirSync(stagingDir, { recursive: true })

    for (const path of paths) {
      try {
        const stat = lstatSync(path.absolute)
        const stagedPath = join(stagingDir, archiveEntryPath(path.original))
        mkdirSync(dirname(stagedPath), { recursive: true })

        if (stat.isSymbolicLink()) {
          symlinkSync(readlinkSync(path.absolute), stagedPath)
        } else if (stat.isFile()) {
          copyFileSync(path.absolute, stagedPath)
          chmodSync(stagedPath, stat.mode & 0o7777)
        } else {
          errors.push({ path: path.original, reason: "Unsupported file type" })
          continue
        }
        stagedFiles++
      } catch (e) {
        errors.push({
          path: path.original,
          reason: e instanceof Error ? e.message : String(e),
        })
      }
    }

    if (stagedFiles === 0) {
      return { archive: new Uint8Array(0), errors }
    }

    const proc = Bun.spawnSync(["tar", "-czf", "-", "-C", stagingDir, "."], {
      stdin: null,
    })
    if (!proc.success) {
      throw new Error(`tar failed: ${proc.stderr.toString()}`)
    }

    return { archive: proc.stdout, errors }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
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
