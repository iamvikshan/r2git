import { resolveActiveProjectConfig, projectR2Prefix } from "../utils/config"
import { getCurrentDirBasename } from "../utils/git"
import {
  checkPathExists,
  getMaxMTime,
  resolvePaths,
  buildPathContext,
} from "../utils/fs"
import { buildManifest, diffManifests } from "../utils/manifest"
import { getLatestManifest } from "../utils/store"
import { formatSize } from "../utils/log"
import type { ResolvedConfig } from "../utils/types"
import type { Manifest } from "../utils/store-types"

async function printLocalStatus(cfg: ResolvedConfig): Promise<{
  maxLocalTime: number
  localManifest: Manifest | null
}> {
  console.log(
    `\nActive Project: ${cfg.project} (${cfg.isLocal ? "local .r2gitconfig" : "global fallback"})`,
  )
  console.log(`R2 Bucket:      ${cfg.r2.bucket ?? "(none)"}`)
  console.log(
    `Backup Prefix:  ${projectR2Prefix(cfg.project, cfg.backup.prefix)}\n`,
  )

  if (cfg.backup.paths.length === 0) {
    console.log(
      "No paths tracked for this project. Run 'r2git add <path>' to start tracking.",
    )
    return { maxLocalTime: 0, localManifest: null }
  }

  const ctx = buildPathContext(cfg.project)
  const resolved = resolvePaths(cfg.backup.paths, ctx)

  console.log("Tracked Files & Directories:")
  let maxLocalTime = 0
  let existingCount = 0
  let missingCount = 0

  const validPaths: Array<{ original: string; absolute: string }> = []

  for (const r of resolved) {
    const exists = await checkPathExists(r.absolute)
    if (exists) {
      existingCount++
      validPaths.push({ original: r.original, absolute: r.absolute })
      const mtime = await getMaxMTime(r.absolute)
      if (mtime) {
        maxLocalTime = Math.max(maxLocalTime, mtime)
        const dateStr = new Date(mtime)
          .toISOString()
          .replace("T", " ")
          .slice(0, 19)
        console.log(
          `  \x1b[32m✔\x1b[0m ${r.original} \x1b[90m(exists, last modified: ${dateStr})\x1b[0m`,
        )
      } else {
        console.log(`  \x1b[32m✔\x1b[0m ${r.original} \x1b[90m(exists)\x1b[0m`)
      }
    } else {
      missingCount++
      console.log(`  \x1b[31m✖\x1b[0m ${r.original} \x1b[90m(missing)\x1b[0m`)
    }
  }

  console.log(`\n  ${existingCount} found, ${missingCount} missing\n`)

  // Build local manifest for diffing
  let localManifest: Manifest | null = null
  if (validPaths.length > 0) {
    try {
      const { manifest, errors } = await buildManifest(
        validPaths,
        cfg.project,
        null,
      )
      if (errors.length === 0) {
        localManifest = manifest
      }
      // If there are errors, skip diff
    } catch {
      // If hashing fails, skip diff
    }
  }

  return { maxLocalTime, localManifest }
}

function printSyncStatus(
  localManifest: Manifest | null,
  remoteManifest: Manifest,
  maxLocalTime: number,
): void {
  if (localManifest) {
    const diff = diffManifests(localManifest, remoteManifest)
    const hasChanges =
      diff.added.length > 0 ||
      diff.changed.length > 0 ||
      diff.removed.length > 0

    if (hasChanges) {
      console.log("\x1b[33mℹ Local files differ from remote backup:\x1b[0m")
      if (diff.added.length > 0)
        console.log(`  \x1b[32m+ ${diff.added.length} new file(s)\x1b[0m`)
      if (diff.changed.length > 0)
        console.log(`  \x1b[33m~ ${diff.changed.length} changed file(s)\x1b[0m`)
      if (diff.removed.length > 0)
        console.log(
          `  \x1b[36m- ${diff.removed.length} removed from local\x1b[0m`,
        )

      const hasLocalAdditionsOrChanges =
        diff.added.length > 0 || diff.changed.length > 0
      const hasOnlyRemovals =
        diff.removed.length > 0 && !hasLocalAdditionsOrChanges

      if (hasOnlyRemovals) {
        console.log(
          "\n  Remote has files not present locally. Run 'r2git diff' to inspect or 'r2git pull' to restore.\n",
        )
      } else {
        console.log(
          "\n  Run 'r2git diff' for details, 'r2git push' to backup, or 'r2git pull' to restore.\n",
        )
      }
    } else {
      console.log(
        "\x1b[32m✔ Workspace is up-to-date with remote backup.\x1b[0m\n",
      )
    }
  } else if (maxLocalTime > 0) {
    const remoteTime = new Date(remoteManifest.timestamp).getTime()
    if (maxLocalTime - remoteTime > 5000) {
      console.log(
        "\x1b[33mℹ Local files have newer modifications than the remote backup.\n  Run 'r2git push' to upload the latest changes.\x1b[0m\n",
      )
    } else if (remoteTime - maxLocalTime > 5000) {
      console.log(
        "\x1b[36mℹ Remote backup is newer than local files.\n  Run 'r2git pull' to restore remote changes.\x1b[0m\n",
      )
    }
  }
}

async function printRemoteStatus(
  cfg: ResolvedConfig,
  maxLocalTime: number,
  localManifest: Manifest | null,
): Promise<void> {
  if (!cfg.r2.accountId || !cfg.r2.accessKeyId || !cfg.r2.secretAccessKey)
    return

  const r2Prefix = projectR2Prefix(cfg.project, cfg.backup.prefix)

  try {
    const latest = await getLatestManifest(cfg.r2, r2Prefix)
    if (!latest) {
      console.log(`\x1b[33mℹ No remote backups found in R2 for this project.
  Run 'r2git push' to create your first backup.\x1b[0m\n`)
      return
    }

    const remoteManifest = latest.manifest
    const entryCount = Object.keys(remoteManifest.entries).length
    const totalSize = Object.values(remoteManifest.entries).reduce(
      (sum, e) => sum + e.size,
      0,
    )

    console.log("Remote Backups:")
    console.log(`  Latest manifest: ${latest.key}`)
    console.log(
      `  Entries: ${entryCount} file(s), ${formatSize(totalSize)} total`,
    )
    console.log(`  Timestamp: ${remoteManifest.timestamp}\n`)

    printSyncStatus(localManifest, remoteManifest, maxLocalTime)
  } catch (e) {
    console.warn(
      `\x1b[33m⚠ Warning: Failed to query R2 backups: ${e instanceof Error ? e.message : String(e)}\x1b[0m\n`,
    )
  }
}

export async function cmdStatus(): Promise<void> {
  const autoName = getCurrentDirBasename()
  const cfg = await resolveActiveProjectConfig(autoName)
  const { maxLocalTime, localManifest } = await printLocalStatus(cfg)
  if (cfg.backup.paths.length > 0) {
    await printRemoteStatus(cfg, maxLocalTime, localManifest)
  }
}
