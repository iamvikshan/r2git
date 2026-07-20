import { homeDir, resolvePaths, type PathContext } from "./fs"
import { parseEnv } from "node:util"
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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

export function defaultProject(_name: string): ProjectConfig {
  return {
    backup: {
      retention: 5,
      paths: [...DEFAULT_PATHS],
      ignores: [],
    },
  }
}

/**
 * Detect R2 credentials in a .env file.
 * Returns the found credentials or null if none found.
 */
export async function detectEnvCredentials(): Promise<{
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket?: string
} | null> {
  const file = Bun.file(`${process.cwd()}/.env`)
  if (!(await file.exists())) return null

  const env = parseEnv(await file.text())

  const accountId = env.R2_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID
  const accessKeyId = env.R2_ACCESS_KEY_ID ?? env.CLOUDFLARE_ACCESS_KEY_ID
  const secretAccessKey =
    env.R2_SECRET_ACCESS_KEY ?? env.CLOUDFLARE_SECRET_ACCESS_KEY
  const bucket = env.R2_BUCKET ?? env.CLOUDFLARE_R2_BUCKET

  if (!accountId || !accessKeyId || !secretAccessKey) return null

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    ...(bucket !== undefined && { bucket }),
  }
}

export function defaultConfig(): GlobalConfig {
  return {
    activeProject: undefined,
    projects: {},
    r2: {
      accountId:
        nonEmptyString(process.env.R2_ACCOUNT_ID) ??
        nonEmptyString(process.env.CLOUDFLARE_ACCOUNT_ID),
      accessKeyId:
        nonEmptyString(process.env.R2_ACCESS_KEY_ID) ??
        nonEmptyString(process.env.CLOUDFLARE_ACCESS_KEY_ID),
      secretAccessKey:
        nonEmptyString(process.env.R2_SECRET_ACCESS_KEY) ??
        nonEmptyString(process.env.CLOUDFLARE_SECRET_ACCESS_KEY),
      bucket:
        nonEmptyString(process.env.R2_BUCKET) ??
        nonEmptyString(process.env.CLOUDFLARE_R2_BUCKET) ??
        "r2git",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeBackupConfig(value: unknown): BackupConfig {
  if (!isRecord(value)) {
    return { retention: 5, paths: [...DEFAULT_PATHS], ignores: [] }
  }

  const backup: BackupConfig = {
    retention: typeof value.retention === "number" ? value.retention : 5,
    paths: Array.isArray(value.paths)
      ? value.paths.filter((path): path is string => typeof path === "string")
      : [...DEFAULT_PATHS],
    ignores: Array.isArray(value.ignores)
      ? value.ignores.filter(
          (pattern): pattern is string => typeof pattern === "string",
        )
      : [],
  }
  if (typeof value.prefix === "string") backup.prefix = value.prefix
  return backup
}

function normalizeProjects(value: unknown): Record<string, ProjectConfig> {
  if (!isRecord(value)) return {}

  const projects: Record<string, ProjectConfig> = {}
  for (const [name, project] of Object.entries(value)) {
    projects[name] = {
      backup: normalizeBackupConfig(
        isRecord(project) ? project.backup : undefined,
      ),
    }
  }
  return projects
}

export async function loadGlobalConfig(): Promise<GlobalConfig> {
  await migrateLegacyConfig()
  const file = Bun.file(configFilePath())
  const exists = await file.exists()
  if (!exists) return defaultConfig()

  try {
    const raw: unknown = JSON.parse(await file.text())
    if (!isRecord(raw)) return defaultConfig()
    const def = defaultConfig()
    const rawR2 = isRecord(raw.r2) ? raw.r2 : {}
    return {
      activeProject:
        typeof raw.activeProject === "string"
          ? raw.activeProject
          : def.activeProject,
      projects: normalizeProjects(raw.projects),
      r2: {
        accountId: nonEmptyString(rawR2.accountId) ?? def.r2.accountId,
        accessKeyId: nonEmptyString(rawR2.accessKeyId) ?? def.r2.accessKeyId,
        secretAccessKey:
          nonEmptyString(rawR2.secretAccessKey) ?? def.r2.secretAccessKey,
        bucket: nonEmptyString(rawR2.bucket) ?? def.r2.bucket,
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
  backup?: unknown
}

export async function loadLocalConfig(): Promise<LocalConfig | null> {
  const file = Bun.file(localConfigFilePath())
  if (!(await file.exists())) return null

  try {
    const parsed: unknown = JSON.parse(await file.text())
    if (!isRecord(parsed)) return null
    const raw: RawLocalConfig = parsed
    if (typeof raw.project !== "string" || !raw.project) return null
    return {
      project: raw.project,
      backup: normalizeBackupConfig(raw.backup),
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
    nonEmptyString(process.env.R2_ACCOUNT_ID) ??
    nonEmptyString(process.env.CLOUDFLARE_ACCOUNT_ID) ??
    global.r2.accountId
  const accessKeyId =
    nonEmptyString(process.env.R2_ACCESS_KEY_ID) ??
    nonEmptyString(process.env.CLOUDFLARE_ACCESS_KEY_ID) ??
    global.r2.accessKeyId
  const secretAccessKey =
    nonEmptyString(process.env.R2_SECRET_ACCESS_KEY) ??
    nonEmptyString(process.env.CLOUDFLARE_SECRET_ACCESS_KEY) ??
    global.r2.secretAccessKey
  const bucket =
    nonEmptyString(process.env.R2_BUCKET) ??
    nonEmptyString(process.env.CLOUDFLARE_R2_BUCKET) ??
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
