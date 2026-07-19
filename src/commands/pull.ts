import fs from "node:fs"
import * as p from "@clack/prompts"
import { resolveActiveProjectConfig, projectR2Prefix } from "../utils/config"
import { getCurrentDirBasename } from "../utils/git"
import { resolvePath, buildPathContext, checkPathExists } from "../utils/fs"
import { hashFile, hashBuffer } from "../utils/hash"
import { tarSymlink } from "../utils/manifest"
import {
  downloadObjectByHash,
  getLatestManifest,
  listManifests,
  downloadManifest,
} from "../utils/store"
import { warn, error as logError, formatSize } from "../utils/log"
import { restoreSymlinkTarFromR2 } from "../helpers/symlink-restore"
import type { ResolvedConfig } from "../utils/types"
import type { Manifest, PullResult } from "../utils/store-types"

async function resolveSpecificManifest(
  cfg: ResolvedConfig,
  r2Prefix: string,
  key: string,
  s: ReturnType<typeof p.spinner>,
): Promise<Manifest> {
  if (key.endsWith(".tar.gz")) {
    s.stop(
      "Legacy tar backup specified — not supported in pull. Use clone for tar backups.",
    )
    p.cancel(
      "Pull only supports manifest-based backups. Specify a .json manifest key or omit --backup.",
    )
    process.exit(1)
  }
  if (!key.endsWith(".json")) {
    const manifests = await listManifests(cfg.r2, r2Prefix)
    const prefix = `${r2Prefix}manifests/${key}`
    const match = manifests.find(m => m.key.startsWith(prefix))
    if (match) {
      key = match.key
      s.message(`Resolved ${key}`)
    } else {
      s.stop(`No manifest found matching timestamp: ${key}`)
      p.cancel(
        `No manifest found matching '${key}'. Use 'r2git log' to see available backups.`,
      )
      process.exit(1)
    }
  }
  return downloadManifest(cfg.r2, key)
}

/**
 * Restore a single symlink-tar file from the manifest.
 * Returns true if restored from R2, false if already correct locally.
 */
async function restoreSymlinkTar(
  r2Config: ResolvedConfig["r2"],
  projectPrefix: string,
  path: string,
  entry: Manifest["entries"][string],
  absolutePath: string,
): Promise<"restored" | "cached" | "error"> {
  try {
    // Cache check: if local symlink matches, skip download
    try {
      if (fs.lstatSync(absolutePath).isSymbolicLink()) {
        const localTar = tarSymlink(absolutePath)
        const localHash = hashBuffer(localTar)
        if (localHash === entry.hash) {
          return "cached"
        }
      }
    } catch {
      // Path doesn't exist or can't be read — proceed with download
    }

    // Use shared helper for restoration
    const result = await restoreSymlinkTarFromR2(
      r2Config,
      entry,
      projectPrefix,
      absolutePath,
    )

    if (result.status === "success") {
      return "restored"
    }

    // Log pull-specific error context based on status
    if (result.status === "extract-failed") {
      logError(`Failed to extract symlink tar for ${path}`, "pull")
    } else if (result.status === "validation-failed") {
      logError(
        `Invalid symlink archive for ${path}: ${result.error ?? "validation failed"}`,
        "pull",
      )
    } else {
      logError(`Failed to install symlink for ${path}`, "pull")
    }

    return "error"
  } catch (e) {
    logError(
      `Failed to restore symlink ${path}: ${e instanceof Error ? e.message : String(e)}`,
      "pull",
    )
    return "error"
  }
}

async function restoreFile(
  r2Config: ResolvedConfig["r2"],
  projectPrefix: string,
  path: string,
  entry: Manifest["entries"][string],
  ctx: ReturnType<typeof buildPathContext>,
): Promise<"restored" | "cached" | "error"> {
  const absolutePath = resolvePath(path, ctx)

  if (entry.type === "symlink-tar") {
    return restoreSymlinkTar(r2Config, projectPrefix, path, entry, absolutePath)
  }

  // Regular file — check if local copy matches
  try {
    const exists = await checkPathExists(absolutePath)
    if (exists) {
      const localHash = await hashFile(absolutePath)
      if (localHash === entry.hash) {
        // Apply permissions before returning cached
        try {
          let isLink = false
          try {
            isLink = fs.lstatSync(absolutePath).isSymbolicLink()
          } catch {}
          if (!isLink) {
            const mode = parseInt(entry.mode, 8)
            try {
              fs.chmodSync(absolutePath, mode)
            } catch {
              warn(`Could not set permissions on ${path}`, "pull")
            }
          }
        } catch {
          // Permission set may fail on some systems — content is correct.
          warn(`Could not set permissions on ${path}`, "pull")
        }
        return "cached"
      }
    }
  } catch {
    // If we can't hash it, we'll re-download
  }

  // Download and write
  try {
    const data = await downloadObjectByHash(r2Config, entry.hash, projectPrefix)

    // Ensure parent directory exists
    const dir =
      absolutePath.lastIndexOf("/") > 0
        ? absolutePath.substring(0, absolutePath.lastIndexOf("/"))
        : "/"
    fs.mkdirSync(dir, { recursive: true })

    // Write file
    await Bun.write(absolutePath, data)

    // Set permissions
    try {
      const mode = parseInt(entry.mode, 8)
      fs.chmodSync(absolutePath, mode)
    } catch {
      // Permission set may fail on some systems — content is already in place.
      warn(`Could not set permissions on ${path}`, "pull")
    }

    return "restored"
  } catch (e) {
    logError(
      `Failed to restore ${path}: ${e instanceof Error ? e.message : String(e)}`,
      "pull",
    )
    return "error"
  }
}

/**
 * Perform the cache-aware pull:
 * 1. Fetch latest manifest
 * 2. For each entry, check if local file matches hash
 * 3. Download only missing/changed files
 */
async function performPull(
  cfg: ResolvedConfig,
  r2Prefix: string,
  specificManifest?: string,
): Promise<PullResult> {
  const result: PullResult = {
    totalFiles: 0,
    restoredFiles: 0,
    cachedFiles: 0,
    errors: [],
  }

  // Step 1: Fetch manifest
  const s = p.spinner()
  s.start("Fetching backup manifest...")

  let manifest: Manifest | null = null
  try {
    if (specificManifest) {
      manifest = await resolveSpecificManifest(
        cfg,
        r2Prefix,
        specificManifest,
        s,
      )
    } else {
      const latest = await getLatestManifest(cfg.r2, r2Prefix)
      if (latest) {
        manifest = latest.manifest
      }
    }
  } catch (e) {
    s.stop("Failed to fetch manifest.")
    logError(e instanceof Error ? e.message : String(e), "pull")
    process.exit(1)
  }

  // If no manifest found, check for legacy tar backups
  if (!manifest) {
    s.stop("No manifest backups found.")
    try {
      const { listObjects } = await import("../utils/r2")
      const all = await listObjects(cfg.r2, r2Prefix)
      const tarBackups = all.filter(a => a.key.endsWith(".tar.gz"))
      if (tarBackups.length > 0) {
        p.cancel(
          `No manifest-based backups found, but ${tarBackups.length} legacy tar backup(s) exist. ` +
            `Use 'r2git clone ${cfg.project}' to restore from legacy tar backups.`,
        )
      } else {
        p.cancel(
          `No backups found for project '${cfg.project}' under prefix ${r2Prefix}.`,
        )
      }
    } catch {
      p.cancel(
        `No backups found for project '${cfg.project}' under prefix ${r2Prefix}.`,
      )
    }
    process.exit(1)
  }

  result.totalFiles = Object.keys(manifest.entries).length
  s.stop(`Manifest loaded: ${result.totalFiles} file(s)`)

  // Step 2: Restore files
  const ctx = buildPathContext(cfg.project)
  const s2 = p.spinner()
  s2.start(`Restoring ${result.totalFiles} file(s)...`)

  let processed = 0
  for (const [path, entry] of Object.entries(manifest.entries)) {
    processed++
    const status = await restoreFile(cfg.r2, r2Prefix, path, entry, ctx)

    switch (status) {
      case "restored":
        result.restoredFiles++
        break
      case "cached":
        result.cachedFiles++
        break
      case "error":
        result.errors.push({ path, reason: "restore failed" })
        break
    }

    if (processed % 10 === 0 || processed === result.totalFiles) {
      s2.message(`Restoring files... (${processed}/${result.totalFiles})`)
    }
  }

  s2.stop(
    `Restore complete: ${result.restoredFiles} restored, ${result.cachedFiles} already up-to-date`,
  )

  return result
}

export async function cmdPull(args: string[]): Promise<void> {
  const autoName = getCurrentDirBasename()
  const cfg = await resolveActiveProjectConfig(autoName)
  if (!cfg.r2.accountId || !cfg.r2.accessKeyId || !cfg.r2.secretAccessKey) {
    p.cancel(
      "Error: Missing Cloudflare R2 credentials. Run 'r2git init' or 'r2git auth login' first.",
    )
    process.exit(1)
  }

  const specificKey =
    args.indexOf("--backup") !== -1
      ? (args[args.indexOf("--backup") + 1] ?? null)
      : null
  const dryRun = args.includes("--dry-run") || args.includes("-n")
  const interactive = args.includes("--interactive") || args.includes("-i")

  const pkgPrefix = cfg.backup.prefix
  const r2Prefix = projectR2Prefix(cfg.project, pkgPrefix)

  let manifestKey: string | undefined

  if (interactive) {
    const manifests = await listManifests(cfg.r2, r2Prefix)
    if (manifests.length === 0) {
      p.cancel(`No backups found under prefix: ${r2Prefix}`)
      process.exit(1)
    }

    const picked = await p.select({
      message: "Select backup to restore",
      options: manifests.map(m => ({
        value: m.key,
        label: `${m.key} (${formatSize(m.size)}, ${m.lastModified})`,
      })),
    })
    if (p.isCancel(picked)) {
      p.cancel("Cancelled.")
      process.exit(0)
    }
    manifestKey = picked as string
  } else if (specificKey) {
    manifestKey = specificKey
  }

  if (dryRun) {
    console.log(`\n[dry-run] Project: ${cfg.project}`)
    console.log(
      `[dry-run] Would fetch manifest from: ${manifestKey ?? "latest"}`,
    )
    console.log("[dry-run] Would compare local file hashes against manifest")
    console.log("[dry-run] Would download only missing/changed files\n")
    return
  }

  const result = await performPull(cfg, r2Prefix, manifestKey)

  if (result.errors.length > 0) {
    warn(`${result.errors.length} error(s) occurred during pull`, "pull")
    console.log("")
    console.log(
      `\x1b[31m✖ Pull incomplete:\x1b[0m ${result.restoredFiles} restored, ${result.cachedFiles} cached, ${result.errors.length} failed`,
    )
    console.log("")
    process.exit(1)
  }

  console.log("")
  console.log(
    `\x1b[32m✔ Pull complete:\x1b[0m ${result.restoredFiles} restored, ${result.cachedFiles} cached`,
  )
  console.log("")
}
