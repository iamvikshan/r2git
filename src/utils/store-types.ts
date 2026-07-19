/**
 * Content-addressed object store types.
 * Mirrors git's model: objects are stored by their SHA-256 hash.
 */

export type ObjectType = "file" | "symlink-tar"

export type ManifestEntry = {
  /** SHA-256 hash of the file content (or symlink tar content) */
  hash: string
  /** Unix file permissions (e.g. "0644", "0755") */
  mode: string
  /** File size in bytes */
  size: number
  /** Last modified timestamp (ISO 8601) */
  mtime: string
  /** "file" for regular files, "symlink-tar" for individually tarred symlinks */
  type: ObjectType
}

export type Manifest = {
  version: 1
  timestamp: string
  project: string
  /** Previous manifest key (for history chain) */
  parent: string | null
  entries: Record<string, ManifestEntry>
}

export type ObjectMeta = {
  hash: string
  size: number
}

export type PushResult = {
  manifestKey: string
  totalFiles: number
  newObjects: number
  skippedObjects: number
  uploadedBytes: number
  errors: Array<{ path: string; reason: string }>
}

export type PullResult = {
  totalFiles: number
  restoredFiles: number
  cachedFiles: number
  errors: Array<{ path: string; reason: string }>
}
