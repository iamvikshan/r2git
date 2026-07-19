import { rmSync } from "node:fs"
import * as p from "@clack/prompts"
import { resolveActiveProjectConfig, projectR2Prefix } from "../utils/config"
import { getCurrentDirBasename } from "../utils/git"
import { resolvePath, buildPathContext } from "../utils/fs"
import { extractArchive } from "../utils/archive"
import { restoreSingleFile } from "../utils/restore"
import {
  downloadArchive,
  getLatestManifest,
  listManifests,
  downloadManifest,
} from "../utils/store"
import { warn, error as logError, formatSize } from "../utils/log"
import type { ResolvedConfig } from "../utils/types"
import type { Manifest, PullResult } from "../utils/store-types"

async function resolveSpecificManifest(
  cfg: ResolvedConfig,
  r2Prefix: string,
  key: string,
  s: ReturnType<typeof p.spinner>,
): Promise<Manifest> {
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
 * Restore all files from an archive.
 */
async function restoreFromArchive(
  cfg: ResolvedConfig,
  manifest: Manifest,
): Promise<PullResult> {
  const result: PullResult = {
    totalFiles: Object.keys(manifest.entries).length,
    restoredFiles: 0,
    cachedFiles: 0,
    errors: [],
  }

  const s = p.spinner()
  s.start("Downloading archive...")

  let archiveData: ArrayBuffer
  try {
    archiveData = await downloadArchive(cfg.r2, manifest.archiveKey)
    s.stop(`Archive downloaded (${formatSize(archiveData.byteLength)})`)
  } catch (e) {
    s.stop("Archive download failed!")
    logError(e instanceof Error ? e.message : String(e), "pull")
    process.exit(1)
  }

  const tmpDir = `/tmp/r2git-restore-${Date.now()}`
  const s2 = p.spinner()
  s2.start("Extracting archive...")

  const { errors: extractErrors } = extractArchive(archiveData, tmpDir)

  if (extractErrors.length > 0) {
    s2.stop("Extraction had errors")
    for (const err of extractErrors) {
      logError(`Extract: ${err.path}: ${err.reason}`, "pull")
    }
  } else {
    s2.stop("Archive extracted")
  }

  const ctx = buildPathContext(cfg.project)
  const s3 = p.spinner()
  s3.start(`Restoring ${result.totalFiles} file(s)...`)

  let processed = 0
  for (const [path, entry] of Object.entries(manifest.entries)) {
    processed++
    const absolutePath = resolvePath(path, ctx)

    try {
      const status = await restoreSingleFile(absolutePath, entry, tmpDir)
      if (status === "restored") result.restoredFiles++
      else if (status === "cached") result.cachedFiles++
      else result.errors.push({ path, reason: "not found in archive" })
    } catch (e) {
      result.errors.push({
        path,
        reason: e instanceof Error ? e.message : String(e),
      })
    }

    if (processed % 10 === 0 || processed === result.totalFiles) {
      s3.message(`Restoring files... (${processed}/${result.totalFiles})`)
    }
  }

  s3.stop(
    `Restore complete: ${result.restoredFiles} restored, ${result.cachedFiles} already up-to-date`,
  )

  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}

  return result
}

/**
 * Perform the cache-aware pull.
 */
async function performPull(
  cfg: ResolvedConfig,
  r2Prefix: string,
  specificManifest?: string,
): Promise<PullResult> {
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

  if (!manifest) {
    s.stop("No backups found.")
    p.cancel(
      `No backups found for project '${cfg.project}' under prefix ${r2Prefix}.`,
    )
    process.exit(1)
  }

  if (!manifest.archiveKey) {
    s.stop("Manifest has no archive — unsupported format.")
    p.cancel("This backup does not contain an archive and cannot be restored.")
    process.exit(1)
  }

  s.stop(`Manifest loaded: ${Object.keys(manifest.entries).length} file(s)`)

  return restoreFromArchive(cfg, manifest)
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
    console.log("[dry-run] Would download archive and extract files")
    console.log("[dry-run] Would skip files already matching local hashes\n")
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
