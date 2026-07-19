import fs from "node:fs"
import { downloadObjectByHash } from "../utils/store"
import { debug } from "../utils/log"
import type { R2Config } from "../utils/types"
import type { ManifestEntry } from "../utils/store-types"

type RestoreResult = {
  status: "success" | "extract-failed" | "validation-failed" | "install-failed"
  error?: string
}

export async function restoreSymlinkTarFromR2(
  r2Config: R2Config,
  entry: ManifestEntry,
  projectPrefix: string,
  absolutePath: string,
): Promise<RestoreResult> {
  try {
    const data = await downloadObjectByHash(r2Config, entry.hash, projectPrefix)

    const dir =
      absolutePath.lastIndexOf("/") > 0
        ? absolutePath.substring(0, absolutePath.lastIndexOf("/"))
        : "/"
    fs.mkdirSync(dir, { recursive: true })

    const proc = Bun.spawnSync(
      ["tar", "-xf", "-", "-C", "/", "--strip-components=0"],
      { stdin: new Uint8Array(data) },
    )
    if (!proc.success) {
      const stderr = proc.stderr.toString().trim()
      debug(
        `tar extract failed for ${absolutePath}: ${stderr}`,
        "symlink-restore",
      )
      return { status: "extract-failed", error: stderr }
    }

    try {
      const stat = fs.lstatSync(absolutePath)
      if (!stat.isSymbolicLink()) {
        return {
          status: "validation-failed",
          error: `Path exists but is not a symlink: ${absolutePath}`,
        }
      }
    } catch {
      return {
        status: "validation-failed",
        error: `Symlink not found after extraction: ${absolutePath}`,
      }
    }

    return { status: "success" }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    debug(`install failed for ${absolutePath}: ${msg}`, "symlink-restore")
    return { status: "install-failed", error: msg }
  }
}
