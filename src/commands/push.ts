import * as p from "@clack/prompts"
import { resolveActiveProjectConfig, projectR2Prefix } from "../utils/config"
import { getCurrentDirBasename } from "../utils/git"
import { resolvePaths, buildPathContext } from "../utils/fs"
import { buildManifest, diffManifests } from "../utils/manifest"
import { createArchive } from "../utils/archive"
import {
  uploadArchive,
  uploadManifest,
  getLatestManifest,
  enforceManifestRetention,
} from "../utils/store"
import {
  info,
  warn,
  error as logError,
  printPathResult,
  printPathSummary,
  formatSize,
  type PathResult,
} from "../utils/log"
import type { ResolvedConfig } from "../utils/types"
import type { Manifest, PushResult } from "../utils/store-types"

async function buildLocalManifest(cfg: ResolvedConfig): Promise<{
  manifest: Manifest
  pathResults: PathResult[]
}> {
  const ctx = buildPathContext(cfg.project)
  const resolved = resolvePaths(cfg.backup.paths, ctx)

  const pathResults: PathResult[] = []
  const validPaths: Array<{ original: string; absolute: string }> = []

  for (const r of resolved) {
    try {
      const { checkPathExists, getFileSize, isSymlink } =
        await import("../utils/fs")
      const symlink = isSymlink(r.absolute)
      if (!symlink) {
        const exists = await checkPathExists(r.absolute)
        if (!exists) {
          pathResults.push({
            path: r.original,
            status: "skipped",
            reason: "file not found",
          })
          continue
        }
      }
      const size = await getFileSize(r.absolute)
      pathResults.push({
        path: r.original,
        status: "ok",
        ...(size !== null && { size }),
      })
      validPaths.push({ original: r.original, absolute: r.absolute })
    } catch (e) {
      pathResults.push({
        path: r.original,
        status: "error",
        reason: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const { manifest, errors: buildErrors } = await buildManifest(
    validPaths,
    cfg.project,
    cfg.backup.ignores,
  )

  for (const err of buildErrors) {
    pathResults.push({
      path: err.path,
      status: "error",
      reason: err.reason,
    })
  }

  return { manifest, pathResults }
}

async function fetchRemoteManifest(
  r2: ResolvedConfig["r2"],
  r2Prefix: string,
): Promise<Manifest | null> {
  const s = p.spinner()
  s.start("Checking remote state...")
  try {
    const latest = await getLatestManifest(r2, r2Prefix)
    if (latest) {
      s.stop(
        `Found remote manifest (${Object.keys(latest.manifest.entries).length} entries)`,
      )
      return latest.manifest
    }
    s.stop("No previous backup found — this will be a full backup")
    return null
  } catch (e) {
    s.stop("Could not fetch remote manifest — proceeding with full backup")
    warn(
      `Remote manifest fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      "push",
    )
    return null
  }
}

function hasChanges(
  manifest: Manifest,
  remoteManifest: Manifest | null,
): boolean {
  if (!remoteManifest) return true
  const diff = diffManifests(manifest, remoteManifest)
  info(
    `Changes: ${diff.added.length} added, ${diff.changed.length} changed, ${diff.removed.length} removed, ${diff.unchanged.length} unchanged`,
    "diff",
  )
  return (
    diff.added.length > 0 || diff.changed.length > 0 || diff.removed.length > 0
  )
}

async function createAndUploadArchive(
  cfg: ResolvedConfig,
  manifest: Manifest,
  r2Prefix: string,
  result: PushResult,
): Promise<boolean> {
  const ctx = buildPathContext(cfg.project)

  // Build list of paths to archive from the manifest (ignores already applied)
  const pathsToArchive: Array<{ original: string; absolute: string; relative: string }> = []
  for (const originalPath of Object.keys(manifest.entries)) {
    const absolute = resolvePaths([originalPath], ctx)[0]?.absolute
    if (absolute) {
      const relative = absolute.startsWith("/") ? absolute.slice(1) : absolute
      pathsToArchive.push({ original: originalPath, absolute, relative })
    }
  }

  const s = p.spinner()
  s.start("Creating archive...")
  const { archive, errors: archiveErrors } = createArchive(pathsToArchive)

  if (archiveErrors.length > 0) {
=======
  const { archive, errors: archiveErrors } = createArchive(resolved)
>>>>>>> 831bef0 (fix: preserve per-file hashes instead of overwriting with archive hash)

  if (archiveErrors.length > 0) {
    for (const err of archiveErrors) {
      result.errors.push(err)
    }
  }

  if (archive.length === 0) {
    s.stop("Archive creation failed — no files to archive")
    logError("No files could be archived", "push")
    return false
  }
  s.stop(`Archive created (${formatSize(archive.length)})`)

  const s2 = p.spinner()
  s2.start("Uploading archive...")
  try {
    manifest.archiveKey = await uploadArchive(cfg.r2, archive, r2Prefix)
    result.uploadedBytes = archive.length
    result.newObjects = 1
    s2.stop(`Archive uploaded: ${manifest.archiveKey}`)
    return true
  } catch (e) {
    s2.stop("Archive upload failed!")
    logError(e instanceof Error ? e.message : String(e), "archive")
    result.errors.push({
      path: "archive",
      reason: e instanceof Error ? e.message : String(e),
    })
    return false
  }
}

async function uploadManifestAndCleanup(
  cfg: ResolvedConfig,
  manifest: Manifest,
  r2Prefix: string,
  retention: number,
  result: PushResult,
): Promise<void> {
  const s = p.spinner()
  s.start("Uploading manifest...")
  try {
    result.manifestKey = await uploadManifest(cfg.r2, manifest, r2Prefix)
    s.stop(`Manifest uploaded: ${result.manifestKey}`)
  } catch (e) {
    s.stop("Manifest upload failed!")
    logError(e instanceof Error ? e.message : String(e), "manifest")
    throw e
  }

  const cleaned = await enforceManifestRetention(cfg.r2, r2Prefix, retention)
  if (cleaned > 0) {
    info(`Cleaned up ${cleaned} old manifest(s)`, "retention")
  }
}

async function performPush(
  cfg: ResolvedConfig,
  r2Prefix: string,
  retention: number,
): Promise<PushResult> {
  const result: PushResult = {
    manifestKey: "",
    totalFiles: 0,
    newObjects: 0,
    skippedObjects: 0,
    uploadedBytes: 0,
    errors: [],
  }

  const s = p.spinner()
  s.start("Hashing tracked files...")
  const { manifest, pathResults } = await buildLocalManifest(cfg)
  result.totalFiles = Object.keys(manifest.entries).length
  s.stop(`Hashed ${result.totalFiles} file(s)`)

  for (const r of pathResults) {
    printPathResult(r)
  }
  printPathSummary(pathResults)

  const buildErrors = pathResults.filter(r => r.status === "error")
  if (buildErrors.length > 0) {
    logError(`${buildErrors.length} file(s) failed during hashing`, "push")
    result.errors = buildErrors.map(r => ({
      path: r.path,
      reason: r.reason ?? "unknown error",
    }))
    return result
  }

  if (result.totalFiles === 0) return result

  const remoteManifest = await fetchRemoteManifest(cfg.r2, r2Prefix)

  if (!hasChanges(manifest, remoteManifest)) {
    info("No changes detected — nothing to upload", "push")
    await enforceManifestRetention(cfg.r2, r2Prefix, retention)
    result.manifestKey = "up-to-date"
    return result
  }

  const uploadOk = await createAndUploadArchive(cfg, manifest, r2Prefix, result)
  if (!uploadOk) return result

  await uploadManifestAndCleanup(cfg, manifest, r2Prefix, retention, result)

  return result
}

function parsePushArgs(
  args: string[],
  cfg: ResolvedConfig,
): {
  retention: number
  pkgPrefix: string | undefined
  dryRun: boolean
  quiet: boolean
} {
  const keepIdx = args.indexOf("--keep")
  let retention = cfg.backup.retention
  if (keepIdx !== -1) {
    const keepValue = args[keepIdx + 1]
    if (!keepValue || keepValue.trim() === "") {
      p.cancel("Error: --keep requires a numeric value")
      process.exit(1)
    }
    const parsed = Number(keepValue)
    if (isNaN(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      p.cancel("Error: --keep must be a positive integer (minimum 1)")
      process.exit(1)
    }
    retention = parsed
  }
  const prefixIdx = args.indexOf("--prefix")
  let pkgPrefix = cfg.backup.prefix
  if (prefixIdx !== -1) {
    const prefixValue = args[prefixIdx + 1]
    if (!prefixValue || prefixValue.startsWith("-")) {
      p.cancel("Error: --prefix requires a value")
      process.exit(1)
    }
    pkgPrefix = prefixValue
  }
  const dryRun = args.includes("--dry-run") || args.includes("-n")
  const quiet = args.includes("--quiet") || args.includes("-q")

  return { retention, pkgPrefix, dryRun, quiet }
}

function printDryRun(cfg: ResolvedConfig, retention: number): void {
  const ctx = buildPathContext(cfg.project)
  const resolved = resolvePaths(cfg.backup.paths, ctx)
  console.log("[dry-run] Project:", cfg.project)
  console.log("[dry-run] Would hash and archive these paths:")
  for (const r of resolved) {
    console.log(`  ${r.original} → ${r.absolute}`)
  }
  console.log("[dry-run] Would create tar.gz archive and upload to R2")
  console.log(`[dry-run] Would retain ${retention} most recent manifests`)
  console.log("")
}

export async function cmdPush(args: string[]): Promise<void> {
  const autoName = getCurrentDirBasename()
  const cfg = await resolveActiveProjectConfig(autoName)
  if (!cfg.r2.accountId || !cfg.r2.accessKeyId || !cfg.r2.secretAccessKey) {
    p.cancel(
      "Error: Missing Cloudflare R2 credentials. Run 'r2git init' or 'r2git auth login' first.",
    )
    process.exit(1)
  }

  const { retention, pkgPrefix, dryRun, quiet } = parsePushArgs(args, cfg)

  if (args.includes("--verbose") || args.includes("-v")) {
    const { setLogLevel } = await import("../utils/log")
    setLogLevel("debug")
  }

  const r2Prefix = projectR2Prefix(cfg.project, pkgPrefix)

  if (!quiet) {
    info(`Project: ${cfg.project}`, "push")
    info(`Tracked paths: ${cfg.backup.paths.length}`, "push")
    info(`Retention: ${retention} backup(s)`, "push")
    console.log("")
  }

  if (dryRun) {
    printDryRun(cfg, retention)
    return
  }

  const result = await performPush(cfg, r2Prefix, retention)

  if (result.totalFiles === 0) {
    p.cancel("No tracked paths exist locally. Nothing to backup.")
    process.exit(1)
  }

  if (result.errors.length > 0) {
    logError(`${result.errors.length} error(s) occurred during push`, "push")
    process.exit(1)
  }

  console.log("")
  if (result.manifestKey === "up-to-date") {
    console.log(
      `\x1b[32m✔ Already up-to-date:\x1b[0m ${result.totalFiles} files, no changes detected`,
    )
  } else {
    console.log(
      `\x1b[32m✔ Push complete:\x1b[0m ${result.totalFiles} files, ` +
        `${formatSize(result.uploadedBytes)} uploaded`,
    )
    console.log(`  Manifest: ${result.manifestKey}`)
  }
  console.log("")
}
