import * as p from "@clack/prompts"
import { getCurrentDirBasename } from "../utils/git"
import { info } from "../utils/log"
import { projectR2Prefix, resolveActiveProjectConfig } from "../utils/config"
import { cleanupOrphanedArchives } from "../utils/store"

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined

  const value = args[index + 1]
  if (!value || value.startsWith("-")) {
    p.cancel(`Error: ${name} requires a value`)
    process.exit(1)
  }
  return value
}

export async function cmdCleanup(args: string[]): Promise<void> {
  const cfg = await resolveActiveProjectConfig(getCurrentDirBasename())
  if (!cfg.r2.accountId || !cfg.r2.accessKeyId || !cfg.r2.secretAccessKey) {
    p.cancel(
      "Error: Missing Cloudflare R2 credentials. Run 'r2git init' or 'r2git auth login' first.",
    )
    process.exit(1)
  }

  const hoursValue = readOption(args, "--min-age") ?? "24"
  const minAgeHours = Number(hoursValue)
  if (!Number.isFinite(minAgeHours) || minAgeHours < 1) {
    p.cancel("Error: --min-age must be a number of hours greater than zero")
    process.exit(1)
  }

  const prefix = readOption(args, "--prefix")
  const dryRun = !args.includes("--yes") && !args.includes("-y")
  const projectPrefix = projectR2Prefix(
    cfg.project,
    prefix ?? cfg.backup.prefix,
  )
  const result = await cleanupOrphanedArchives(cfg.r2, projectPrefix, {
    dryRun,
    minAgeMs: minAgeHours * 60 * 60 * 1000,
  })

  if (dryRun) {
    info(
      `${result.candidates} orphaned archive(s) eligible for deletion. Re-run with --yes to delete them.`,
      "cleanup",
    )
    return
  }

  info(`Deleted ${result.deleted} orphaned archive(s).`, "cleanup")
}
