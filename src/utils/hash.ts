/**
 * Compute SHA-256 hash of a file, streaming for large files.
 * Returns hex-encoded hash string.
 */
export async function hashFile(filePath: string): Promise<string> {
  const file = Bun.file(filePath)
  const stat = await file.stat()

  if (stat.size < 4 * 1024 * 1024) {
    const buf = await file.arrayBuffer()
    return hashBuffer(buf)
  }

  // For larger files, stream to avoid memory pressure
  const hasher = new Bun.CryptoHasher("sha256")
  const reader = file.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    hasher.update(value)
  }
  return hasher.digest("hex")
}

/**
 * Compute SHA-256 hash of a buffer.
 */
export function hashBuffer(buf: ArrayBuffer | Uint8Array): string {
  return new Bun.CryptoHasher("sha256")
    .update(new Uint8Array(buf))
    .digest("hex")
}

/**
 * Compute SHA-256 hash of a string.
 */
export function hashString(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex")
}

/**
 * Get the R2 object key for a given hash.
 * Uses first 2 chars as directory prefix to avoid flat listing issues.
 * e.g. "a38f2c...d4" → "objects/a3/8f2c...d4"
 */
export function objectKey(hash: string, projectPrefix: string): string {
  const dir = hash.slice(0, 2)
  const rest = hash.slice(2)
  return `${projectPrefix}objects/${dir}/${rest}`
}
