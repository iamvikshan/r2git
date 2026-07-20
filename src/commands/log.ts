import * as p from "@clack/prompts"
import { resolveActiveProjectConfig, projectR2Prefix } from "../utils/config"
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
  if (
    prefixIdx !== -1 &&
    (!args[prefixIdx + 1]?.length || args[prefixIdx + 1]?.startsWith("-"))
  ) {
    p.cancel("Error: --prefix requires a value")
    process.exit(1)
  }
  const pkgPrefix = prefixIdx !== -1 ? args[prefixIdx + 1] : cfg.backup.prefix
  const r2Prefix = projectR2Prefix(cfg.project, pkgPrefix)
  const detailed = args.includes("--verbose") || args.includes("-v")

  const s = p.spinner()
  s.start("Querying backup history...")

  let manifests: Array<{ key: string; lastModified: string; size: number }> = []
  try {
    manifests = await listManifests(cfg.r2, r2Prefix)
  } catch (e) {
    s.stop("Failed to query backups.")
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }

  s.stop("History loaded.")

  if (manifests.length === 0) {
    console.log(
      `No backups found for project "${cfg.project}" under prefix "${r2Prefix}".`,
    )
    return
  }

  console.log(
    `\nHistory for project "${cfg.project}" (${manifests.length} backups):`,
  )
  console.log("─".repeat(70))
  for (const m of manifests) {
    await printManifestEntry(m, cfg.r2, detailed)
  }
}
