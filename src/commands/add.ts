import * as p from "@clack/prompts"
import {
  loadLocalConfig,
  writeLocalConfig,
  LOCAL_CONFIG_FILENAME,
} from "../utils/config"
import { resolvePath, buildPathContext, isPathUnderBase } from "../utils/fs"
import { info } from "../utils/log"
import type { LocalConfig } from "../utils/types"

async function handleIgnoreFlag(
  local: LocalConfig,
  args: string[],
): Promise<void> {
  const patterns = args.slice(1).filter(Boolean)
  if (patterns.length === 0) {
    const typed = await p.text({
      message: "Enter ignore pattern(s) to add (comma-separated)",
      placeholder: ".gossip/cache, **/*.tmp, node_modules",
      validate(val) {
        if (!val?.trim()) return "At least one pattern is required"
        return undefined
      },
    })
    if (p.isCancel(typed)) {
      p.cancel("Cancelled.")
      process.exit(0)
    }
    patterns.push(
      ...(typed as string)
        .split(",")
        .map(s => s.trim())
        .filter(Boolean),
    )
  }

  const currentIgnores = new Set(local.backup.ignores)
  let addedCount = 0
  for (const pattern of patterns) {
    if (!currentIgnores.has(pattern)) {
      local.backup.ignores.push(pattern)
      currentIgnores.add(pattern)
      addedCount++
      info(`Added ignore pattern: ${pattern}`, "add")
    } else {
      info(`Pattern already ignored: ${pattern}`, "add")
    }
  }

  if (addedCount > 0) {
    await writeLocalConfig(local)
    p.note(
      `Added ${addedCount} ignore pattern(s) to ${LOCAL_CONFIG_FILENAME}`,
      "Success",
    )
  } else {
    p.note("No new patterns were added.", "Info")
  }
}

async function handlePathAdd(
  local: LocalConfig,
  args: string[],
): Promise<void> {
  let pathsToAdd = args.filter(Boolean)

  if (pathsToAdd.length === 0) {
    const typed = await p.text({
      message: "Enter path(s) to add (comma-separated)",
      placeholder: ".env, secrets.json, {home}/.config/app/config.json",
      validate(val) {
        if (!val?.trim()) return "Path is required"
        return undefined
      },
    })
    if (p.isCancel(typed)) {
      p.cancel("Cancelled.")
      process.exit(0)
    }
    pathsToAdd = typed
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
  }

  const ctx = buildPathContext(local.project)
  const currentPaths = new Set(local.backup.paths)
  let addedCount = 0

  for (const path of pathsToAdd) {
    const absPath = resolvePath(path, ctx)
    let resolved = path

    if (isPathUnderBase(absPath, ctx.cwd)) {
      const rel = absPath.slice(ctx.cwd.length).replace(/^\//, "")
      resolved = `{cwd}/${rel}`
    } else if (isPathUnderBase(absPath, ctx.home)) {
      const rel = absPath.slice(ctx.home.length).replace(/^\//, "")
      resolved = `{home}/${rel}`
    }

    if (!currentPaths.has(resolved)) {
      local.backup.paths.push(resolved)
      currentPaths.add(resolved)
      addedCount++
      info(`Staged tracked path: ${resolved}`, "add")
    } else {
      info(`Path already tracked: ${resolved}`, "add")
    }
  }

  if (addedCount > 0) {
    await writeLocalConfig(local)
    p.note(`Added ${addedCount} path(s) to ${LOCAL_CONFIG_FILENAME}`, "Success")
  } else {
    p.note("No new paths were added.", "Info")
  }
}

export async function cmdAdd(args: string[]): Promise<void> {
  const local = await loadLocalConfig()

  if (!local) {
    p.cancel(
      "No local .r2gitconfig found in this directory. Run 'r2git init' first.",
    )
    process.exit(1)
  }

  if (args[0] === "--ignore" || args[0] === "-I") {
    await handleIgnoreFlag(local, args)
    return
  }

  await handlePathAdd(local, args)
}
