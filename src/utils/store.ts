import { uploadObject, downloadObject, listObjects, deleteObject } from "./r2"
import type { R2Config } from "./types"
import type { Manifest } from "./store-types"
import { serializeManifest, deserializeManifest } from "./manifest"
import { debug, info } from "./log"

/**
 * Upload an archive to R2.
 */
export async function uploadArchive(
  r2: R2Config,
  archive: Uint8Array,
  projectPrefix: string,
): Promise<string> {
  const key = archiveKey(projectPrefix)
  await uploadObject(r2, key, archive, "application/gzip")
  debug(`Uploaded archive ${key}`, "store")
  return key
}

/**
 * Download an archive from R2.
 */
export async function downloadArchive(
  r2: R2Config,
  archiveKey: string,
): Promise<ArrayBuffer> {
  return downloadObject(r2, archiveKey)
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

/**
 * Enforce retention on manifests and their archives.
 */
export async function enforceManifestRetention(
  r2: R2Config,
  projectPrefix: string,
  retention: number,
): Promise<number> {
  if (
    typeof retention !== "number" ||
    !Number.isInteger(retention) ||
    retention < 1
  ) {
    debug(`Invalid retention value ${retention}, skipping cleanup`, "retention")
    return 0
  }
  let manifests: Array<{ key: string; lastModified: string; size: number }>
  try {
    manifests = await listManifests(r2, projectPrefix)
  } catch (e) {
    info(
      `Failed to list manifests for retention, aborting: ${e instanceof Error ? e.message : String(e)}`,
      "retention",
    )
    return 0
  }

  if (manifests.length <= retention) return 0

  const stale = manifests.slice(retention)

  let deleted = 0
  for (const m of stale) {
    try {
      // Download manifest to get archive key for cleanup
      const manifest = await downloadManifest(r2, m.key)

      // Delete the archive
      if (manifest.archiveKey) {
        try {
          await deleteObject(r2, manifest.archiveKey)
          debug(`Deleted archive ${manifest.archiveKey}`, "retention")
        } catch (e) {
          debug(
            `Failed to delete archive ${manifest.archiveKey}: ${e instanceof Error ? e.message : String(e)}`,
            "retention",
          )
        }
      }

      // Delete the manifest
      await deleteObject(r2, m.key)
      deleted++
      info(`Deleted old manifest: ${m.key}`, "retention")
    } catch (e) {
      info(
        `Failed to delete manifest ${m.key}: ${e instanceof Error ? e.message : String(e)}`,
        "retention",
      )
    }
  }

  return deleted
}

function archiveKey(projectPrefix: string): string {
  const suffix = Math.random().toString(36).substring(2, 8)
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  return `${projectPrefix}archives/${ts}-${suffix}.tar.gz`
}

function manifestKey(timestamp: string, projectPrefix: string): string {
  const sanitized = timestamp.replace(/[:.]/g, "-")
  const suffix = Math.random().toString(36).substring(2, 8)
  return `${projectPrefix}manifests/${sanitized}-${suffix}.json`
}
