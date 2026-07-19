export type R2Config = {
  accountId: string | undefined
  accessKeyId: string | undefined
  secretAccessKey: string | undefined
  bucket: string | undefined
}

export type BackupConfig = {
  prefix?: string
  retention: number
  paths: string[]
  ignores: string[]
}

export type ProjectConfig = {
  backup: BackupConfig
}

export type GlobalConfig = {
  activeProject: string | undefined
  projects: Record<string, ProjectConfig>
  r2: R2Config
  dopplerToken?: string | undefined
}

export type LocalConfig = {
  project: string
  backup: BackupConfig
}

export type ResolvedConfig = {
  project: string
  r2: R2Config
  backup: BackupConfig
  isLocal: boolean
}
