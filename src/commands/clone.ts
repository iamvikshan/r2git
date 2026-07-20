import { rmSync, mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as p from "@clack/prompts"
import {
  loadGlobalConfig,
  writeLocalConfig,
  projectR2Prefix,
  DEFAULT_PATHS,
} from "../utils/config"
import { getLatestManifest, downloadArchive } from "../utils/store"
import { buildPathContext, resolvePath } from "../utils/fs"
import { extractArchive } from "../utils/archive"
import { restoreSingleFile } from "../utils/restore"
import { warn, error as logError, formatSize } from "../utils/log"

import type { Manifest } from "../utils/store-types"

type GlobalCfg =
  ReturnType<typeof loadGlobalConfig> extends Promise<infer T> ? T : never

/**
 * Restore all files from an archive-based manifest.
 */
async function restoreFromManifest(
  globalConfig: GlobalCfg,
  manifest: Manifest,
  projectName: string,
): Promise<{ restored: number; cached: number; errors: number }> {
  if (!manifest.archiveKey) {
    logError("Manifest has no archive key — unsupported format", "clone")
    return { restored: 0, cached: 0, errors: 1 }
  }

  const s = p.spinner()
  s.start("Downloading archive...")

  let archive: Awaited<ReturnType<typeof downloadArchive>>
  try {
    archive = await downloadArchive(globalConfig.r2, manifest.archiveKey)
    s.stop(
      archive.size === null
        ? "Archive download started"
        : `Archive download started (${formatSize(archive.size)})`,
    )
  } catch (e) {
    s.stop("Archive download failed!")
    logError(e instanceof Error ? e.message : String(e), "clone")
    return { restored: 0, cached: 0, errors: 1 }
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "r2git-clone-"))
  const s2 = p.spinner()
  s2.start("Extracting archive...")

  const { errors: extractErrors } = await extractArchive(archive.stream, tmpDir)

  if (extractErrors.length > 0) {
    s2.stop("Extraction had errors")
    for (const err of extractErrors) {
      logError(`Extract: ${err.path}: ${err.reason}`, "clone")
    }
  } else {
    s2.stop("Archive extracted")
  }

  const entries = Object.entries(manifest.entries)
  const s3 = p.spinner()
  s3.start(`Restoring ${entries.length} file(s)...`)

  const ctx = buildPathContext(projectName)
  let restored = 0
  let cached = 0
  let errors = 0

  for (const [path, entry] of entries) {
    try {
      const absolutePath = resolvePath(path, ctx)
      const status = await restoreSingleFile(path, absolutePath, entry, tmpDir)
      if (status === "restored") restored++
      else if (status === "cached") cached++
      else errors++
    } catch (e) {
      errors++
      logError(
        `Failed to restore ${path}: ${e instanceof Error ? e.message : String(e)}`,
        "clone",
      )
    }

    if ((restored + cached + errors) % 10 === 0) {
      s3.message(
        `Restoring files... (${restored + cached + errors}/${entries.length})`,
      )
    }
  }

  s3.stop(`Restored ${restored} file(s), ${cached} cached, ${errors} error(s)`)

  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}

  return { restored, cached, errors }
}

async function finishClone(
  name: string,
  pkgPrefix: string | undefined,
  retention: number,
  paths: string[],
  ignores: string[] = [],
): Promise<void> {
  await writeLocalConfig({
    project: name,
    backup: {
      retention,
      ...(pkgPrefix !== undefined && { prefix: pkgPrefix }),
      paths,
      ignores,
    },
  })
  p.outro(
    "Local .r2gitconfig created. Ready to run r2git status and r2git push (^_<) ~*",
  )
}

async function promptProjectName(): Promise<string> {
  const typed = await p.text({
    message: "Enter project name to clone (format: [org]/[repo])",
    validate(val) {
      if (!val?.trim()) return "Project name is required"
      return undefined
    },
  })
  if (p.isCancel(typed)) {
    p.cancel("Cancelled.")
    process.exit(0)
  }
  return typed as string
}

async function lookupLatestBackup(
  global: ReturnType<typeof loadGlobalConfig> extends Promise<infer T>
    ? T
    : never,
  name: string,
  r2Prefix: string,
): Promise<{ manifest: Manifest; key: string }> {
  const s = p.spinner()
  s.start(`Looking up backups for '${name}'...`)

  let latest: { manifest: Manifest; key: string } | null = null
  let lookupError: string | null = null
  try {
    latest = await getLatestManifest(global.r2, r2Prefix)
  } catch (e) {
    lookupError = e instanceof Error ? e.message : String(e)
  }

  if (!latest) {
    if (lookupError) {
      s.stop("Failed to query backups.")
      logError(lookupError, "clone")
      p.cancel(`Backup query failed: ${lookupError}`)
      process.exit(1)
    }
    s.stop("No backups found.")
    p.cancel(
      `No backups found on R2 for project '${name}' under prefix '${r2Prefix}'.`,
    )
    process.exit(1)
  }

  s.stop(`Found manifest: ${latest.key}`)
  return latest
}

export async function cmdClone(projectName: string | undefined): Promise<void> {
  p.intro("r2git clone")
  const global = await loadGlobalConfig()
  if (
    !global.r2.accountId ||
    !global.r2.accessKeyId ||
    !global.r2.secretAccessKey
  ) {
    p.cancel(
      "Error: Missing Cloudflare R2 credentials. Run 'r2git init' or 'r2git auth login' first.",
    )
    process.exit(1)
  }

  const name = projectName ?? (await promptProjectName())

  const projectCfg = global.projects[name]
  const defaultRetention = projectCfg ? projectCfg.backup.retention : 5
  const pkgPrefix = projectCfg ? projectCfg.backup.prefix : undefined
  const r2Prefix = projectR2Prefix(name, pkgPrefix)

  const latest = await lookupLatestBackup(global, name, r2Prefix)

  const result = await restoreFromManifest(global, latest.manifest, name)

  if (result.errors > 0) {
    warn(`${result.errors} file(s) failed to restore`, "clone")
    p.cancel(
      `Clone incomplete: ${result.restored} restored, ${result.cached} cached, ${result.errors} failed.`,
    )
    process.exit(1)
  }

  const manifestPaths = Object.keys(latest.manifest.entries)
  const configuredPaths =
    projectCfg?.backup.paths ??
    (manifestPaths.length > 0 ? manifestPaths : [...DEFAULT_PATHS])
  const configuredIgnores = projectCfg?.backup.ignores ?? []
  await finishClone(
    name,
    pkgPrefix,
    defaultRetention,
    configuredPaths,
    configuredIgnores,
  )
}
