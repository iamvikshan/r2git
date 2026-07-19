import * as p from "@clack/prompts"
import {
  loadLocalConfig,
  writeLocalConfig,
  LOCAL_CONFIG_FILENAME,
} from "../utils/config"
import { resolvePath, buildPathContext, isPathUnderBase } from "../utils/fs"
import { info } from "../utils/log"

export async function cmdAdd(args: string[]): Promise<void> {
  const local = await loadLocalConfig()

  if (!local) {
    p.cancel(
      "No local .r2gitconfig found in this directory. Run 'r2git init' first.",
    )
    process.exit(1)
  }

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
    // Try to canonicalize: if the resolved path is under cwd, store as {cwd}/...
    const absPath = resolvePath(path, ctx)
    let resolved = path

    if (isPathUnderBase(absPath, ctx.cwd)) {
      const rel = absPath.slice(ctx.cwd.length).replace(/^\//, "")
      resolved = `{cwd}/${rel}`
    } else if (isPathUnderBase(absPath, ctx.home)) {
      const rel = absPath.slice(ctx.home.length).replace(/^\//, "")
      resolved = `{home}/${rel}`
    }
    // else: keep as-is (absolute path or variable form the user typed)

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
