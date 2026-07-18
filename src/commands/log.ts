import * as p from "@clack/prompts"
import { resolveActiveProjectConfig, projectR2Prefix } from "../utils/config"
import { listObjects } from "../utils/r2"
import { listManifests, downloadManifest } from "../utils/store"
import { getCurrentDirBasename } from "../utils/git"
import { formatSize } from "../utils/log"
import type { R2Config } from "../utils/types"

async function printManifestEntry(
  m: { key: string; lastModified: string; size: number },
  r2: R2Config,
  detailed: boolean,
): Promise<void> {
  const date = new Date(m.lastModified).toLocaleString()
  const size = formatSize(m.size)
  const keyParts = m.key.split("/")
  const filename = keyParts[keyParts.length - 1] ?? m.key

  if (detailed) {
    try {
      const manifest = await downloadManifest(r2, m.key)
      const entries = Object.keys(manifest.entries).length
      const totalSize = Object.values(manifest.entries).reduce(
        (sum, e) => sum + e.size,
        0,
      )
      console.log(`  backup ${filename}`)
      console.log(`  Date:     ${date}`)
      console.log(`  Size:     ${size}`)
      console.log(
        `  Entries:  ${entries} file(s), ${formatSize(totalSize)} content`,
      )
      if (manifest.parent) {
        console.log(`  Parent:   ${manifest.parent.split("/").pop()}`)
      }
    } catch {
      console.log(`  backup ${filename}`)
      console.log(`  Date:   ${date}`)
      console.log(`  Size:   ${size}`)
    }
  } else {
    console.log(`  backup ${filename}`)
    console.log(`  Date:   ${date}`)
    console.log(`  Size:   ${size}`)
  }
  console.log("─".repeat(70))
}

function printManifests(
  project: string,
  r2: R2Config,
  manifests: Array<{ key: string; lastModified: string; size: number }>,
  detailed: boolean,
): void {
  if (manifests.length === 0) return
  console.log(
    `\nHistory for project "${project}" (${manifests.length} manifest backups):`,
  )
  console.log("─".repeat(70))
  for (const m of manifests) {
    void printManifestEntry(m, r2, detailed)
  }
}

function printLegacyBackups(
  project: string,
  manifests: Array<{ key: string; lastModified: string; size: number }>,
  legacyBackups: Array<{ key: string; lastModified: string; size: number }>,
): void {
  if (legacyBackups.length === 0) return
  if (manifests.length > 0) {
    console.log("\nLegacy tar backups:")
    console.log("─".repeat(70))
  } else {
    console.log(
      `\nHistory for project "${project}" (${legacyBackups.length} legacy backups):`,
    )
    console.log("─".repeat(70))
  }
  for (const b of legacyBackups) {
    const size = formatSize(b.size)
    const keyParts = b.key.split("/")
    const filename = keyParts[keyParts.length - 1] ?? b.key
    const date = new Date(b.lastModified).toLocaleString()
    console.log(`  backup ${filename}`)
    console.log(`  Date:   ${date}`)
    console.log(`  Size:   ${size}`)
    console.log("─".repeat(70))
  }
}

async function listBackups(
  cfg: { r2: R2Config; project: string },
  r2Prefix: string,
): Promise<{
  manifests: Array<{ key: string; lastModified: string; size: number }>
  legacyBackups: Array<{ key: string; lastModified: string; size: number }>
}> {
  const s = p.spinner()
  s.start("Querying backup history...")

  let manifests: Array<{ key: string; lastModified: string; size: number }> = []
  let manifestError: string | null = null
  try {
    manifests = await listManifests(cfg.r2, r2Prefix)
  } catch (e) {
    manifestError = e instanceof Error ? e.message : String(e)
  }

  let legacyBackups: Array<{
    key: string
    lastModified: string
    size: number
  }> = []
  let legacyError: string | null = null
  try {
    const all = await listObjects(cfg.r2, r2Prefix)
    legacyBackups = all
      .filter(a => a.key.endsWith(".tar.gz"))
      .sort(
        (a, b) =>
          new Date(b.lastModified).getTime() -
          new Date(a.lastModified).getTime(),
      )
  } catch (e) {
    legacyError = e instanceof Error ? e.message : String(e)
  }

  s.stop("History loaded.")

  if (manifestError && legacyError) {
    console.error(
      `\nError querying backup history: manifest listing failed (${manifestError}), legacy listing failed (${legacyError})`,
    )
    process.exit(1)
  }

  if (manifestError && manifests.length === 0) {
    console.warn(`\nWarning: Failed to list manifest backups: ${manifestError}`)
  }
  if (legacyError && legacyBackups.length === 0) {
    console.warn(`Warning: Failed to list legacy backups: ${legacyError}`)
  }

  return { manifests, legacyBackups }
}

export async function cmdLog(args: string[]): Promise<void> {
  const autoName = getCurrentDirBasename()
  const cfg = await resolveActiveProjectConfig(autoName)
  if (!cfg.r2.accountId || !cfg.r2.accessKeyId || !cfg.r2.secretAccessKey) {
    p.cancel(
      "Error: Missing Cloudflare R2 credentials. Run 'r2git init' first.",
    )
    process.exit(1)
  }

  const prefixIdx = args.indexOf("--prefix")
  const pkgPrefix =
    prefixIdx !== -1
      ? (args[prefixIdx + 1] ?? cfg.backup.prefix)
      : cfg.backup.prefix
  const r2Prefix = projectR2Prefix(cfg.project, pkgPrefix)
  const detailed = args.includes("--verbose") || args.includes("-v")

  const { manifests, legacyBackups } = await listBackups(cfg, r2Prefix)

  printManifests(cfg.project, cfg.r2, manifests, detailed)
  printLegacyBackups(cfg.project, manifests, legacyBackups)

  if (manifests.length === 0 && legacyBackups.length === 0) {
    console.log(
      `No backups found for project "${cfg.project}" under prefix "${r2Prefix}".`,
    )
  }
}
