import {
  uploadObject,
  downloadObject,
  listObjects,
  headObject,
  deleteObject,
} from "./r2"
import { objectKey, hashBuffer } from "./hash"
import type { R2Config } from "./types"
import type { Manifest } from "./store-types"
import { serializeManifest, deserializeManifest } from "./manifest"
import { debug, info } from "./log"

/**
 * Check if an object exists in R2 by hash.
 */
export async function objectExists(
  r2: R2Config,
  hash: string,
  projectPrefix: string,
): Promise<boolean> {
  const key = objectKey(hash, projectPrefix)
  return headObject(r2, key)
}

/**
 * Upload a single object to R2 if it doesn't already exist.
 * Returns true if uploaded, false if already present.
 */
export async function uploadObjectIfMissing(
  r2: R2Config,
  hash: string,
  data: ArrayBuffer | Uint8Array,
  projectPrefix: string,
): Promise<boolean> {
  const key = objectKey(hash, projectPrefix)

  // Verify content-addressed integrity: hash must match data
  const actualHash = hashBuffer(data)
  if (actualHash !== hash) {
    throw new Error(
      `Content-address verification failed for upload: expected ${hash}, got ${actualHash}`,
    )
  }

  // Check existence first (avoid unnecessary uploads)
  const exists = await headObject(r2, key)
  if (exists) {
    debug(`Object ${hash.slice(0, 12)}… already on R2, skipping`, "store")
    return false
  }

  await uploadObject(r2, key, data, "application/octet-stream")
  debug(`Uploaded object ${hash.slice(0, 12)}…`, "store")
  return true
}

/**
 * Download a single object from R2 by hash.
 */
export async function downloadObjectByHash(
  r2: R2Config,
  hash: string,
  projectPrefix: string,
): Promise<ArrayBuffer> {
  const key = objectKey(hash, projectPrefix)
  const data = await downloadObject(r2, key)

  // Verify content-addressed integrity: downloaded data must match expected hash
  const actualHash = hashBuffer(data)
  if (actualHash !== hash) {
    throw new Error(
      `Content-address verification failed for download: expected ${hash}, got ${actualHash}`,
    )
  }

  return data
}

/**
 * Upload a manifest to R2.
 */
export async function uploadManifest(
  r2: R2Config,
  manifest: Manifest,
  projectPrefix: string,
): Promise<string> {
  const key = manifestKey(manifest.timestamp, projectPrefix)
  const json = serializeManifest(manifest)
  await uploadObject(r2, key, json, "application/json")
  debug(`Uploaded manifest ${key}`, "store")
  return key
}

/**
 * Download a manifest from R2 by key.
 */
export async function downloadManifest(
  r2: R2Config,
  key: string,
): Promise<Manifest> {
  const buf = await downloadObject(r2, key)
  const text = new TextDecoder().decode(buf)
  return deserializeManifest(text)
}

/**
 * List all manifests for a project, sorted newest first.
 */
export async function listManifests(
  r2: R2Config,
  projectPrefix: string,
): Promise<Array<{ key: string; lastModified: string; size: number }>> {
  const prefix = `${projectPrefix}manifests/`
  const all = await listObjects(r2, prefix)
  return all
    .filter(a => a.key.endsWith(".json"))
    .sort(
      (a, b) =>
        new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime(),
    )
}

/**
 * Get the latest manifest for a project. Returns null if none exist.
 */
export async function getLatestManifest(
  r2: R2Config,
  projectPrefix: string,
): Promise<{ manifest: Manifest; key: string } | null> {
  const manifests = await listManifests(r2, projectPrefix)
  if (manifests.length === 0) return null

  const latest = manifests[0]
  if (!latest) return null
  const manifest = await downloadManifest(r2, latest.key)
  return { manifest, key: latest.key }
}

async function gcUnreferencedObjects(
  r2: R2Config,
  projectPrefix: string,
  referencedHashes: Set<string>,
): Promise<void> {
  let allObjects: Array<{ key: string; lastModified: string; size: number }>
  try {
    allObjects = await listObjects(r2, `${projectPrefix}objects/`)
  } catch (e) {
    debug(
      `Failed to list objects for GC, aborting: ${e instanceof Error ? e.message : String(e)}`,
      "retention",
    )
    return
  }

  let gcDeleted = 0
  for (const obj of allObjects) {
    const parts = obj.key.split("/")
    const hash =
      parts.length >= 3
        ? (parts[parts.length - 2] ?? "") + (parts[parts.length - 1] ?? "")
        : ""

    if (hash && !referencedHashes.has(hash)) {
      try {
        await deleteObject(r2, obj.key)
        gcDeleted++
        debug(
          `GC deleted unreferenced object: ${hash.slice(0, 12)}…`,
          "retention",
        )
      } catch (e) {
        debug(
          `Failed to delete object ${obj.key}: ${e instanceof Error ? e.message : String(e)}`,
          "retention",
        )
      }
    }
  }

  if (gcDeleted > 0) {
    info(`Garbage collected ${gcDeleted} unreferenced object(s)`, "retention")
  }
}

/**
 * Enforce retention on manifests. Deletes old manifests and their orphaned objects.
 */
export async function enforceManifestRetention(
  r2: R2Config,
  projectPrefix: string,
  retention: number,
): Promise<number> {
  let manifests: Array<{ key: string; lastModified: string; size: number }>
  try {
    manifests = await listManifests(r2, projectPrefix)
  } catch (e) {
    debug(
      `Failed to list manifests for retention, aborting: ${e instanceof Error ? e.message : String(e)}`,
      "retention",
    )
    return 0
  }

  if (manifests.length <= retention) return 0

  const stale = manifests.slice(retention)
  const retained = manifests.slice(0, retention)
  let deleted = 0

  // Collect hashes referenced by retained manifests
  const referencedHashes = new Set<string>()
  let retainedReadFailed = false
  for (const m of retained) {
    try {
      const manifest = await downloadManifest(r2, m.key)
      for (const entry of Object.values(manifest.entries)) {
        referencedHashes.add(entry.hash)
      }
    } catch (e) {
      retainedReadFailed = true
      debug(
        `Failed to read manifest ${m.key} for GC, aborting object cleanup: ${e instanceof Error ? e.message : String(e)}`,
        "retention",
      )
      // Abort object cleanup to prevent incomplete snapshot
      break
    }
  }

  // Abort deletion if we couldn't read all retained manifests
  if (retainedReadFailed) {
    debug(
      "Aborting retention cleanup: incomplete manifest snapshot",
      "retention",
    )
    return 0
  }

  // Delete stale manifests (only if we have a complete snapshot)
  for (const m of stale) {
    try {
      await deleteObject(r2, m.key)
      deleted++
      info(`Deleted old manifest: ${m.key}`, "retention")
    } catch (e) {
      debug(
        `Failed to delete manifest ${m.key}, aborting: ${e instanceof Error ? e.message : String(e)}`,
        "retention",
      )
      // Abort if we can't delete a stale manifest
      return deleted
    }
  }

  // Only run GC if we successfully deleted all stale manifests
  if (deleted === stale.length) {
    await gcUnreferencedObjects(r2, projectPrefix, referencedHashes)
  }

  return deleted
}

function manifestKey(timestamp: string, projectPrefix: string): string {
  const sanitized = timestamp.replace(/[:.]/g, "-")
  const suffix = Math.random().toString(36).substring(2, 8)
  return `${projectPrefix}manifests/${sanitized}-${suffix}.json`
}
