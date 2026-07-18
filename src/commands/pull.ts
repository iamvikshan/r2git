import * as p from "@clack/prompts"
import { resolveActiveProjectConfig, projectR2Prefix } from "../utils/config"
import { getCurrentDirBasename } from "../utils/git"
import { resolvePath, buildPathContext, checkPathExists } from "../utils/fs"
import { hashFile } from "../utils/hash"
import {
  downloadObjectByHash,
  getLatestManifest,
  listManifests,
  downloadManifest,
} from "../utils/store"
import { warn, error as logError, formatSize } from "../utils/log"
import type { ResolvedConfig } from "../utils/types"
import type { Manifest, PullResult } from "../utils/store-types"

/**
 * Restore a single file from the manifest.
 * Returns true if restored from R2, false if already correct locally.
 */
async function restoreSymlinkTar(
  r2Config: ResolvedConfig["r2"],
  projectPrefix: string,
  path: string,
  entry: Manifest["entries"][string],
  absolutePath: string,
): Promise<"restored" | "error"> {
  try {
    const data = await downloadObjectByHash(r2Config, entry.hash, projectPrefix)
    // Write tar to temp and extract into isolated directory
    const tmpDir = process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"
    const tmpTar = `${tmpDir}/r2git-symlink-${entry.hash}-${Date.now()}.tar`
    const extractDir = `${tmpDir}/r2git-extract-${entry.hash}-${Date.now()}`
    try {
      await Bun.write(tmpTar, data)
      Bun.spawnSync(["mkdir", "-p", extractDir])
      const extractProc = Bun.spawnSync([
        "tar",
        "-xf",
        tmpTar,
        "-C",
        extractDir,
      ])
      if (!extractProc.success) {
        logError(`Failed to extract symlink tar for ${path}`, "pull")
        return "error"
      }
      // Validate that exactly one symlink was extracted
      const listProc = Bun.spawnSync(["find", extractDir, "-type", "l"])
      const symlinks = listProc.stdout
        .toString()
        .trim()
        .split("\n")
        .filter(l => l)
      if (symlinks.length !== 1) {
        logError(
          `Invalid symlink archive for ${path}: expected 1 symlink, found ${symlinks.length}`,
          "pull",
        )
        return "error"
      }
      const extractedLink = symlinks[0]
      if (!extractedLink) {
        logError(`No symlink found in archive for ${path}`, "pull")
        return "error"
      }
      // Ensure the destination parent exists (symlink-only nested paths
      // may have no parent on a fresh machine), and clear any existing
      // destination so a directory→symlink transition replaces the old
      // directory instead of copying the link inside it.
      const parentDir =
        absolutePath.lastIndexOf("/") > 0
          ? absolutePath.substring(0, absolutePath.lastIndexOf("/"))
          : "/"
      Bun.spawnSync(["mkdir", "-p", parentDir])
      Bun.spawnSync(["rm", "-rf", absolutePath])
      // Install the validated symlink at the manifest-derived absolutePath
      const installProc = Bun.spawnSync([
        "cp",
        "-a",
        extractedLink,
        absolutePath,
      ])
      if (!installProc.success) {
        logError(`Failed to install symlink for ${path}`, "pull")
        return "error"
      }
      return "restored"
    } finally {
      Bun.spawnSync(["rm", "-rf", extractDir])
      Bun.spawnSync(["rm", "-f", tmpTar])
    }
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
        // Use test -L to avoid following symlinks (TOCTOU safety)
        try {
          const isLink =
            Bun.spawnSync(["test", "-L", absolutePath]).exitCode === 0
          if (!isLink) {
            const mode = parseInt(entry.mode, 8).toString(8)
            const chmodProc = Bun.spawnSync(["chmod", mode, absolutePath])
            if (!chmodProc.success || chmodProc.exitCode !== 0) {
              // The content is already correct; a permission-sync failure
              // (read-only fs, insufficient rights) should warn, not abort.
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
    Bun.spawnSync(["mkdir", "-p", dir])

    // Write file
    await Bun.write(absolutePath, data)

    // Set permissions
    try {
      const mode = parseInt(entry.mode, 8).toString(8)
      const chmodProc = Bun.spawnSync(["chmod", mode, absolutePath])
      if (!chmodProc.success || chmodProc.exitCode !== 0) {
        return "error"
      }
    } catch {
      // Permission set may fail on some systems
      return "error"
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
      // Check if user provided a .tar.gz key explicitly
      if (specificManifest.endsWith(".tar.gz")) {
        s.stop(
          "Legacy tar backup specified — not supported in pull. Use clone for tar backups.",
        )
        p.cancel(
          "Pull only supports manifest-based backups. Specify a .json manifest key or omit --backup.",
        )
        process.exit(1)
      }
      manifest = await downloadManifest(cfg.r2, specificManifest)
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
