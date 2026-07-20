import * as p from "@clack/prompts"
import {
  loadGlobalConfig,
  loadLocalConfig,
  writeLocalConfig,
  writeGlobalConfig,
  LOCAL_CONFIG_FILENAME,
  DEFAULT_PATHS,
  detectEnvCredentials,
} from "../utils/config"
import {
  getCurrentDirBasename,
  getGitRemoteOrigin,
  parseProjectFromRemote,
  gitInit,
} from "../utils/git"
import { cmdAuthDoppler, promptR2Credentials } from "./auth"
import type { LocalConfig } from "../utils/types"

function handleGitSetup(): void {
  if (!Bun.spawnSync(["git", "status"], { cwd: process.cwd() }).success) {
    if (gitInit(process.cwd())) {
      p.note("Git repository initialized.", "Git")
    }
  }
  Bun.spawnSync(["git", "add", LOCAL_CONFIG_FILENAME])
  p.note(`Staged ${LOCAL_CONFIG_FILENAME} in Git.`, "Git")
}

async function promptIgnores(local: LocalConfig | null): Promise<string[]> {
  const existingIgnores = local?.backup.ignores ?? []
  const addIgnores = await p.confirm({
    message: "Do you want to add ignore patterns for tracked directories?",
    initialValue: existingIgnores.length > 0,
  })
  if (p.isCancel(addIgnores)) {
    p.cancel("Cancelled.")
    process.exit(0)
  }

  if (!addIgnores) return [...existingIgnores]

  const typed = await p.text({
    message:
      "Enter ignore patterns (comma-separated, glob-style: dir/cache, **/*.tmp)",
    initialValue: existingIgnores.join(", "),
    placeholder: ".gossip/cache, **/*.log, node_modules",
  })
  if (p.isCancel(typed)) {
    p.cancel("Cancelled.")
    process.exit(0)
  }
  return (typed as string)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
}

async function promptLocalConfig(local: LocalConfig | null): Promise<void> {
  const autoName = getCurrentDirBasename()
  const gitRemote = getGitRemoteOrigin()
  const defaultProjName = gitRemote
    ? (parseProjectFromRemote(gitRemote) ?? autoName)
    : autoName

  const projectName = await p.text({
    message: "Project name (format: [org]/[repo])",
    initialValue: local?.project ?? defaultProjName,
    validate(val) {
      if (!val?.trim()) return "Project name is required"
      return undefined
    },
  })
  if (p.isCancel(projectName)) {
    p.cancel("Cancelled.")
    process.exit(0)
  }

  const selectPaths = await p.multiselect({
    message: "Select default files/folders to track",
    options: DEFAULT_PATHS.map(path => ({
      value: path,
      label: path,
      hint: "workspace",
    })),
    required: false,
  })
  if (p.isCancel(selectPaths)) {
    p.cancel("Cancelled.")
    process.exit(0)
  }

  const paths = selectPaths as string[]
  const ignores = await promptIgnores(local)

  const newLocal: LocalConfig = {
    project: projectName as string,
    backup: {
      retention: local?.backup.retention ?? 5,
      paths:
        paths.length > 0 ? paths : (local?.backup.paths ?? [...DEFAULT_PATHS]),
      ignores,
    },
  }
  await writeLocalConfig(newLocal)
  p.note(
    `Created local ${LOCAL_CONFIG_FILENAME} with project: "${projectName}"`,
    "Local Config",
  )

  handleGitSetup()
}

function importedBucket(
  envBucket: string | undefined,
  configuredBucket: string | undefined,
): string {
  const normalizedEnvBucket = envBucket === "" ? undefined : envBucket
  return normalizedEnvBucket ?? configuredBucket ?? "r2git"
}

export async function cmdInit(): Promise<void> {
  p.intro("r2git init")

  const global = await loadGlobalConfig()
  let hasCreds = !!(
    global.r2.accountId &&
    global.r2.accessKeyId &&
    global.r2.secretAccessKey
  )

  // Smart .env detection
  if (!hasCreds) {
    const envCreds = await detectEnvCredentials()
    if (envCreds) {
      p.note(
        `Found R2 credentials in .env:\n` +
          `  Account ID:     ${envCreds.accountId.slice(0, 4)}...\n` +
          `  Access Key ID:  ${envCreds.accessKeyId.slice(0, 4)}...\n` +
          `  Bucket:         ${importedBucket(envCreds.bucket, global.r2.bucket)}`,
        ".env Detection",
      )

      const useEnv = await p.confirm({
        message:
          "Import these credentials into ~/.r2gitrc? (The .env will not be read again by r2git)",
        initialValue: true,
      })
      if (p.isCancel(useEnv)) {
        p.cancel("Cancelled.")
        process.exit(0)
      }

      if (useEnv) {
        global.r2 = {
          accountId: envCreds.accountId,
          accessKeyId: envCreds.accessKeyId,
          secretAccessKey: envCreds.secretAccessKey,
          bucket: importedBucket(envCreds.bucket, global.r2.bucket),
        }
        await writeGlobalConfig(global)
        p.note(
          "Credentials saved to ~/.r2gitrc. r2git will no longer read .env for credentials.",
          "Import Complete",
        )
        // Recompute credential completeness after import
        hasCreds = true
      }
    }
  }

  const configureR2 =
    !hasCreds &&
    (await p.confirm({
      message:
        "Do you want to configure global Cloudflare R2 / Doppler credentials manually?",
      initialValue: false,
    }))

  if (p.isCancel(configureR2)) {
    p.cancel("Cancelled.")
    process.exit(0)
  }

  if (configureR2) {
    const authMethod = await p.select({
      message: "Select configuration source:",
      options: [
        { value: "doppler", label: "Import credentials from Doppler" },
        { value: "manual", label: "Manual credentials input" },
      ],
    })
    if (p.isCancel(authMethod)) {
      p.cancel("Cancelled.")
      process.exit(0)
    }

    if (authMethod === "doppler") {
      await cmdAuthDoppler()
    } else {
      await promptR2Credentials(global)
    }
  }

  const local = await loadLocalConfig()
  await promptLocalConfig(local)

  p.outro(
    "r2git initialized! You are ready to run r2git push and r2git pull (^_<) ~*",
  )
}
