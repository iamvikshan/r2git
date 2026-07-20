/**
 * Content-addressed object store types.
 * Mirrors git's model: objects are stored by their SHA-256 hash.
 */

export type ObjectType = "file" | "symlink-tar"

export type ManifestEntry = {
  /** SHA-256 hash of the file content or raw symlink target */
  hash: string
  /** Unix file permissions (e.g. "0644", "0755") */
  mode: string
  /** File size in bytes */
  size: number
  /** Last modified timestamp (ISO 8601) */
  mtime: string
  /** "file" for regular files, "symlink-tar" for symlink compatibility */
  type: ObjectType
}

export type Manifest = {
  version: 1
  timestamp: string
  project: string
  /** R2 key of the tar.gz archive containing all objects */
  archiveKey: string
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
