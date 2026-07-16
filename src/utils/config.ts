import type {
  ProjectConfig,
  GlobalConfig,
  LocalConfig,
  ResolvedConfig,
  BackupConfig,
  R2Config,
} from "./types"
import { homeDir } from "./fs"

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
    },
  }
}

export async function loadWorkspaceEnv(): Promise<void> {
  const file = Bun.file(`${process.cwd()}/.env`)
  if (await file.exists()) {
    const text = await file.text()
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
        process.env[k] = val
      }
    }
  }
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
        process.env.R2_BUCKET ??
        process.env.CLOUDFLARE_R2_BUCKET ??
        "r2git-backups",
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
  await loadWorkspaceEnv()
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
  await loadWorkspaceEnv()
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

export function resolveTarPaths(
  paths: string[],
  cwd: string,
  home: string,
): string[] {
  return paths.map(p => {
    let resolved = p
    if (resolved.startsWith("~")) {
      resolved = resolved.replace("~", home)
    }
    resolved = resolved.replace("{cwd}", cwd)
    return resolved.startsWith("/") ? resolved.slice(1) : resolved
  })
}
