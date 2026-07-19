import { homeDir, resolvePaths, type PathContext } from "./fs"
import type {
  BackupConfig,
  GlobalConfig,
  LocalConfig,
  ProjectConfig,
  R2Config,
  ResolvedConfig,
} from "./types"

const CONFIG_FILENAME = ".r2gitrc"
const LEGACY_MIGRATE_FILENAME = ".migraterc"
const LEGACY_NOGIT_FILENAME = ".nogitrc"
export const LOCAL_CONFIG_FILENAME = ".r2gitconfig"

export function configFilePath(): string {
  return `${homeDir()}/${CONFIG_FILENAME}`
}

export function localConfigFilePath(): string {
  return `${process.cwd()}/${LOCAL_CONFIG_FILENAME}`
}

export const DEFAULT_PATHS: string[] = ["{cwd}/.env"]

export function defaultProject(_name: string): ProjectConfig {
  return {
    backup: {
      retention: 5,
      paths: [...DEFAULT_PATHS],
      ignores: [],
    },
  }
}

export async function loadWorkspaceEnv(): Promise<void> {
  const file = Bun.file(`${process.cwd()}/.env`)
  if (await file.exists()) {
    const env = parseEnvFile(await file.text())
    for (const [k, v] of Object.entries(env)) {
      process.env[k] = v
    }
  }
}

function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const idx = trimmed.indexOf("=")
    if (idx !== -1) {
      const k = trimmed.slice(0, idx).trim()
      const v = trimmed.slice(idx + 1).trim()
      const val =
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
          ? v.slice(1, -1)
          : v
      env[k] = val
    }
  }
  return env
}

/**
 * Detect R2 credentials in a .env file.
 * Returns the found credentials or null if none found.
 */
export async function detectEnvCredentials(): Promise<{
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
} | null> {
  const file = Bun.file(`${process.cwd()}/.env`)
  if (!(await file.exists())) return null

  const env = parseEnvFile(await file.text())

  const accountId = env.R2_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID
  const accessKeyId = env.R2_ACCESS_KEY_ID ?? env.CLOUDFLARE_ACCESS_KEY_ID
  const secretAccessKey =
    env.R2_SECRET_ACCESS_KEY ?? env.CLOUDFLARE_SECRET_ACCESS_KEY
  const bucket = env.R2_BUCKET ?? env.CLOUDFLARE_R2_BUCKET

  if (!accountId || !accessKeyId || !secretAccessKey) return null

  return { accountId, accessKeyId, secretAccessKey, bucket: bucket ?? "r2git" }
}

export function defaultConfig(): GlobalConfig {
  return {
    activeProject: undefined,
    projects: {},
    r2: {
      accountId: process.env.R2_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID,
      accessKeyId:
        process.env.R2_ACCESS_KEY_ID ?? process.env.CLOUDFLARE_ACCESS_KEY_ID,
      secretAccessKey:
        process.env.R2_SECRET_ACCESS_KEY ??
        process.env.CLOUDFLARE_SECRET_ACCESS_KEY,
      bucket:
        process.env.R2_BUCKET ?? process.env.CLOUDFLARE_R2_BUCKET ?? "r2git",
    },
    dopplerToken: undefined,
  }
}

async function tryMigrateFile(
  oldPath: string,
  newPath: string,
): Promise<boolean> {
  const oldFile = Bun.file(oldPath)
  if (await oldFile.exists()) {
    try {
      await Bun.write(newPath, oldFile)
      console.log(`[INFO] Migrated legacy config from ${oldPath} to ${newPath}`)
      return true
    } catch (e) {
      console.warn(
        `[WARN] Failed to migrate config from ${oldPath}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }
  return false
}

export async function migrateLegacyConfig(): Promise<void> {
  const newPath = configFilePath()
  const newFile = Bun.file(newPath)
  if (await newFile.exists()) return

  const home = homeDir()
  const legacyNogit = `${home}/${LEGACY_NOGIT_FILENAME}`
  const legacyMigrate = `${home}/${LEGACY_MIGRATE_FILENAME}`

  if (await tryMigrateFile(legacyNogit, newPath)) return
  await tryMigrateFile(legacyMigrate, newPath)
}

type RawGlobalConfig = {
  activeProject?: unknown
  projects?: unknown
  dopplerToken?: unknown
  r2?: {
    accountId?: unknown
    accessKeyId?: unknown
    secretAccessKey?: unknown
    bucket?: unknown
  }
}

export async function loadGlobalConfig(): Promise<GlobalConfig> {
  await migrateLegacyConfig()
  const file = Bun.file(configFilePath())
  const exists = await file.exists()
  if (!exists) return defaultConfig()

  try {
    const raw = JSON.parse(await file.text()) as RawGlobalConfig
    const def = defaultConfig()
    const rawProjects = raw.projects as
      | Record<string, ProjectConfig>
      | undefined
    return {
      activeProject:
        typeof raw.activeProject === "string"
          ? raw.activeProject
          : def.activeProject,
      projects: rawProjects ?? {},
      r2: {
        accountId:
          typeof raw.r2?.accountId === "string"
            ? raw.r2.accountId
            : def.r2.accountId,
        accessKeyId:
          typeof raw.r2?.accessKeyId === "string"
            ? raw.r2.accessKeyId
            : def.r2.accessKeyId,
        secretAccessKey:
          typeof raw.r2?.secretAccessKey === "string"
            ? raw.r2.secretAccessKey
            : def.r2.secretAccessKey,
        bucket:
          typeof raw.r2?.bucket === "string" ? raw.r2.bucket : def.r2.bucket,
      },
      dopplerToken:
        typeof raw.dopplerToken === "string"
          ? raw.dopplerToken
          : def.dopplerToken,
    }
  } catch {
    return defaultConfig()
  }
}

type RawLocalConfig = {
  project?: unknown
  backup?: {
    prefix?: unknown
    retention?: unknown
    paths?: unknown
  }
}

export async function loadLocalConfig(): Promise<LocalConfig | null> {
  const file = Bun.file(localConfigFilePath())
  if (!(await file.exists())) return null

  try {
    const raw = JSON.parse(await file.text()) as RawLocalConfig
    if (typeof raw.project !== "string" || !raw.project) return null
    const backup = raw.backup ?? {}
    const resBackup: BackupConfig = {
      retention: typeof backup.retention === "number" ? backup.retention : 5,
      paths: Array.isArray(backup.paths)
        ? (backup.paths as string[])
        : [...DEFAULT_PATHS],
      ignores: Array.isArray((backup as { ignores?: unknown }).ignores)
        ? (backup as { ignores: string[] }).ignores
        : [],
    }
    if (typeof backup.prefix === "string") {
      resBackup.prefix = backup.prefix
    }
    return {
      project: raw.project,
      backup: resBackup,
    }
  } catch {
    return null
  }
}

export async function resolveActiveProjectConfig(
  autoName: string,
): Promise<ResolvedConfig> {
  const global = await loadGlobalConfig()
  const local = await loadLocalConfig()

  const accountId =
    process.env.R2_ACCOUNT_ID ??
    process.env.CLOUDFLARE_ACCOUNT_ID ??
    global.r2.accountId
  const accessKeyId =
    process.env.R2_ACCESS_KEY_ID ??
    process.env.CLOUDFLARE_ACCESS_KEY_ID ??
    global.r2.accessKeyId
  const secretAccessKey =
    process.env.R2_SECRET_ACCESS_KEY ??
    process.env.CLOUDFLARE_SECRET_ACCESS_KEY ??
    global.r2.secretAccessKey
  const bucket =
    process.env.R2_BUCKET ??
    process.env.CLOUDFLARE_R2_BUCKET ??
    global.r2.bucket

  const r2: R2Config = {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
  }

  if (local) {
    return {
      project: local.project,
      r2,
      backup: local.backup,
      isLocal: true,
    }
  }

  const project = global.activeProject ?? autoName
  const projectCfg = global.projects[project] ?? defaultProject(project)

  return {
    project,
    r2,
    backup: projectCfg.backup,
    isLocal: false,
  }
}

export async function writeGlobalConfig(config: GlobalConfig): Promise<void> {
  const content = JSON.stringify(config, null, 2)
  await Bun.write(configFilePath(), content)
}

export async function writeLocalConfig(config: LocalConfig): Promise<void> {
  const content = JSON.stringify(config, null, 2)
  await Bun.write(localConfigFilePath(), content)
}

export function projectR2Prefix(
  project: string,
  packagePrefix?: string,
): string {
  if (packagePrefix) {
    const pkg = packagePrefix.endsWith("/")
      ? packagePrefix
      : `${packagePrefix}/`
    const clean = pkg.startsWith("/") ? pkg.slice(1) : pkg
    return `projects/${project}/${clean}`
  }
  return project.endsWith("/") ? project : `${project}/`
}

/**
 * @deprecated Use resolvePaths from fs.ts instead.
 * Kept for backward compatibility — delegates to the unified resolver.
 */
export function resolveTarPaths(
  paths: string[],
  cwd: string,
  home: string,
): string[] {
  const ctx: PathContext = { cwd, home }
  return resolvePaths(paths, ctx).map(r => r.relative)
}
