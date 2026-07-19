import fs from "node:fs"
import * as p from "@clack/prompts"
import {
  loadGlobalConfig,
  writeLocalConfig,
  projectR2Prefix,
  DEFAULT_PATHS,
} from "../utils/config"
import { listObjects, downloadObject } from "../utils/r2"
import { getLatestManifest, downloadObjectByHash } from "../utils/store"
import { buildPathContext, resolvePath } from "../utils/fs"
import { info, warn, error as logError, formatSize } from "../utils/log"
import { restoreSymlinkTarFromR2 } from "../helpers/symlink-restore"

import type { Manifest } from "../utils/store-types"

type GlobalCfg =
  ReturnType<typeof loadGlobalConfig> extends Promise<infer T> ? T : never

async function restoreSymlinkTarEntry(
  globalConfig: GlobalCfg,
  entry: Manifest["entries"][string],
  r2Prefix: string,
  absolutePath: string,
  path?: string,
): Promise<boolean> {
  const result = await restoreSymlinkTarFromR2(
    globalConfig.r2,
    entry,
    r2Prefix,
    absolutePath,
  )
  if (result.status === "success") {
    return true
  }
  // Log clone-specific error context
  if (result.error) {
    logError(
      `Failed to restore symlink ${path ?? absolutePath}: ${result.error}`,
      "clone",
    )
  }
  return false
}

async function restoreFileEntry(
  globalConfig: GlobalCfg,
  entry: Manifest["entries"][string],
  r2Prefix: string,
  absolutePath: string,
  path?: string,
): Promise<boolean> {
  const data = await downloadObjectByHash(globalConfig.r2, entry.hash, r2Prefix)
  const dir =
    absolutePath.lastIndexOf("/") > 0
      ? absolutePath.substring(0, absolutePath.lastIndexOf("/"))
      : "/"
  fs.mkdirSync(dir, { recursive: true })
  await Bun.write(absolutePath, data)
  try {
    fs.chmodSync(absolutePath, parseInt(entry.mode, 8))
  } catch {
    warn(`Could not set permissions on ${path ?? absolutePath}`, "clone")
  }
  return true
}

/**
 * Restore from a manifest (new format).
 */
async function restoreFromManifest(
  globalConfig: GlobalCfg,
  manifest: Manifest,
  r2Prefix: string,
  projectName: string,
): Promise<{ restored: number; errors: number }> {
  const entries = Object.entries(manifest.entries)
  const s = p.spinner()
  s.start(`Restoring ${entries.length} file(s) from manifest...`)

  const ctx = buildPathContext(projectName)
  let restored = 0
  let errors = 0

  for (const [path, entry] of entries) {
    try {
      const absolutePath = resolvePath(path, ctx)
      const ok =
        entry.type === "symlink-tar"
          ? await restoreSymlinkTarEntry(
              globalConfig,
              entry,
              r2Prefix,
              absolutePath,
              path,
            )
          : await restoreFileEntry(
              globalConfig,
              entry,
              r2Prefix,
              absolutePath,
              path,
            )
      if (ok) restored++
      else errors++
    } catch (e) {
      errors++
      logError(
        `Failed to restore ${path}: ${e instanceof Error ? e.message : String(e)}`,
        "clone",
      )
    }

    if ((restored + errors) % 10 === 0) {
      s.message(`Restoring files... (${restored + errors}/${entries.length})`)
    }
  }

  s.stop(`Restored ${restored} file(s), ${errors} error(s)`)
  return { restored, errors }
}

/**
 * Legacy restore from tar (backward compat).
 */
async function restoreFromTar(
  globalConfig: ReturnType<typeof loadGlobalConfig> extends Promise<infer T>
    ? T
    : never,
  key: string,
): Promise<void> {
  const s = p.spinner()
  s.message("Downloading project backup...")
  const tmpDir = process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"
  const tmpTar = `${tmpDir}/r2git-backup-${Date.now()}.tar.gz`
  try {
    const buf = await downloadObject(globalConfig.r2, key)
    await Bun.write(tmpTar, buf)
    info(`Downloaded ${formatSize(buf.byteLength)}`, "clone")
  } catch (e) {
    s.stop("Download failed.")
    logError(e instanceof Error ? e.message : String(e), "download")
    process.exit(1)
  }

  s.message("Extracting project files...")
  try {
    const proc = Bun.spawnSync(["tar", "-xzf", tmpTar, "-C", "/"])
    if (!proc.success) {
      s.stop("Extraction failed.")
      const stderr = proc.stderr.toString().trim()
      if (stderr) {
        for (const line of stderr.split("\n").slice(0, 10)) {
          logError(`  ${line}`, "tar")
        }
      }
      process.exit(1)
    }
  } finally {
    fs.rmSync(tmpTar, { force: true })
  }
}

async function finishClone(
  name: string,
  pkgPrefix: string | undefined,
  retention: number,
  paths: string[],
): Promise<void> {
  await writeLocalConfig({
    project: name,
    backup: {
      retention,
      ...(pkgPrefix !== undefined && { prefix: pkgPrefix }),
      paths,
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

async function tryLegacyRestore(
  global: ReturnType<typeof loadGlobalConfig> extends Promise<infer T>
    ? T
    : never,
  name: string,
  pkgPrefix: string | undefined,
  r2Prefix: string,
  retention: number,
): Promise<void> {
  const s = p.spinner()
  s.stop("No manifest found, checking for legacy tar backups...")

  try {
    const all = await listObjects(global.r2, r2Prefix)
    const latest = all
      .filter(a => a.key.endsWith(".tar.gz"))
      .sort(
        (a, b) =>
          new Date(b.lastModified).getTime() -
          new Date(a.lastModified).getTime(),
      )[0]

    if (latest) {
      info("Found legacy tar backup — restoring...", "clone")
      await restoreFromTar(global, latest.key)
      await finishClone(name, pkgPrefix, retention, [...DEFAULT_PATHS])
      return
    }
  } catch (e) {
    s.stop("Failed to query R2 backups.")
    logError(e instanceof Error ? e.message : String(e), "clone")
    process.exit(1)
  }

  s.stop("Clone failed.")
  p.cancel(
    `No backups found on R2 for project '${name}' under prefix '${r2Prefix}'.`,
  )
  process.exit(1)
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

  // Try manifest-based restore first (new format)
  const s = p.spinner()
  s.start(`Looking up backups for '${name}'...`)

  let latest: { manifest: Manifest; key: string } | null = null
  try {
    latest = await getLatestManifest(global.r2, r2Prefix)
  } catch {
    // Failed to query manifests — will fall through to legacy
  }

  if (latest) {
    s.stop(`Found manifest: ${latest.key}`)
    const result = await restoreFromManifest(
      global,
      latest.manifest,
      r2Prefix,
      name,
    )
    if (result.errors > 0) {
      warn(`${result.errors} file(s) failed to restore`, "clone")
      p.cancel(
        `Clone incomplete: ${result.restored} restored, ${result.errors} failed.`,
      )
      process.exit(1)
    }
    // Persist the restored manifest's paths as the clone's tracked paths so
    // the next push doesn't drop them. Preconfigured project paths win when
    // present; otherwise fall back to the manifest keys (or defaults if empty).
    const manifestPaths = Object.keys(latest.manifest.entries)
    const configuredPaths =
      projectCfg?.backup.paths ??
      (manifestPaths.length > 0 ? manifestPaths : [...DEFAULT_PATHS])
    await finishClone(name, pkgPrefix, defaultRetention, configuredPaths)
    return
  }

  await tryLegacyRestore(global, name, pkgPrefix, r2Prefix, defaultRetention)
}
