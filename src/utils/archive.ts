import { lstatSync, mkdirSync } from "node:fs"
import { join, relative, resolve } from "node:path"

export function archiveEntryPath(originalPath: string): string {
  return join("entries", Buffer.from(originalPath).toString("base64url"))
}

function transformSourcePath(path: string): string {
  let transformed = ""
  for (const character of path) {
    if ("\\.^$*[]|".includes(character)) transformed += "\\"
    transformed += character
  }
  return transformed
}

export function createArchive(
  paths: Array<{ original: string; absolute: string }>,
): {
  archive: Uint8Array
  errors: Array<{ path: string; reason: string }>
} {
  const errors: Array<{ path: string; reason: string }> = []
  const sourcePaths: string[] = []
  const transformRules: string[] = []

  for (const path of paths) {
    try {
      const stat = lstatSync(path.absolute)
      if (!stat.isSymbolicLink() && !stat.isFile()) {
        errors.push({ path: path.original, reason: "Unsupported file type" })
        continue
      }

      const sourcePath = relative("/", resolve(path.absolute))
      sourcePaths.push(sourcePath)
      transformRules.push(
        `s|^${transformSourcePath(sourcePath)}$|${archiveEntryPath(path.original)}|`,
      )
    } catch (e) {
      errors.push({
        path: path.original,
        reason: e instanceof Error ? e.message : String(e),
      })
    }
  }

  if (sourcePaths.length === 0) {
    return { archive: new Uint8Array(0), errors }
  }

  const proc = Bun.spawnSync(
    [
      "tar",
      "-czf",
      "-",
      "-C",
      "/",
      "--null",
      "--files-from=-",
      `--transform=${transformRules.join(";")}`,
    ],
    { stdin: new TextEncoder().encode(`${sourcePaths.join("\0")}\0`) },
  )
  if (!proc.success) {
    throw new Error(`tar failed: ${proc.stderr.toString()}`)
  }

  return { archive: proc.stdout, errors }
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
