import { lstatSync, mkdirSync, readlinkSync } from "node:fs"
import type { UploadSink } from "./r2"

const TAR_BLOCK_SIZE = 512
const TAR_SIZE_MAX = Number.parseInt("77777777777", 8)
const textEncoder = new TextEncoder()

type PreparedArchiveEntry =
  | {
      kind: "file"
      archivePath: string
      absolutePath: string
      originalPath: string
      expectedHash: string
      mode: number
      mtimeMs: number
      size: number
    }
  | {
      kind: "inline"
      archivePath: string
      data: Uint8Array<ArrayBuffer>
      originalPath: string
      expectedHash: string
      mode: number
      mtimeMs: number
      size: number
    }

export function archiveEntryPath(entryHash: string): string {
  return `entries/${entryHash}`
}

export function legacyArchiveEntryPath(originalPath: string): string {
  return `entries/${Buffer.from(originalPath).toString("base64url")}`
}

function writeTarString(
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = textEncoder.encode(value)
  if (bytes.length > length) {
    throw new Error(`Tar field exceeds ${length} bytes: ${value}`)
  }
  target.set(bytes, offset)
}

function writeTarOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const normalized = Math.max(0, Math.trunc(value))
  const octal = normalized.toString(8)
  if (octal.length > length - 1) {
    throw new Error(`Tar numeric field exceeds ${length} bytes: ${value}`)
  }
  writeTarString(target, offset, length, `${octal.padStart(length - 1, "0")}\0`)
}

function createTarHeader(
  entry: PreparedArchiveEntry,
  options: {
    archivePath?: string
    size?: number
    typeFlag?: number
  } = {},
): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(new ArrayBuffer(TAR_BLOCK_SIZE))
  writeTarString(header, 0, 100, options.archivePath ?? entry.archivePath)
  writeTarOctal(header, 100, 8, entry.mode)
  writeTarOctal(header, 108, 8, 0)
  writeTarOctal(header, 116, 8, 0)
  writeTarOctal(header, 124, 12, options.size ?? entry.size)
  writeTarOctal(header, 136, 12, Math.floor(entry.mtimeMs / 1000))
  header.fill(0x20, 148, 156)
  header[156] = options.typeFlag ?? 0x30
  writeTarString(header, 257, 6, "ustar\0")
  writeTarString(header, 263, 2, "00")

  let checksum = 0
  for (const byte of header) checksum += byte
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `)
  return header
}

function createPaxRecord(key: string, value: string): Uint8Array<ArrayBuffer> {
  let length = 0
  for (;;) {
    const bytes = textEncoder.encode(`${length} ${key}=${value}\n`)
    if (bytes.length === length) return bytes
    length = bytes.length
  }
}

function prepareArchiveEntries(
  paths: Array<{ original: string; absolute: string; hash: string }>,
): {
  entries: PreparedArchiveEntry[]
  errors: Array<{ path: string; reason: string }>
} {
  const entries: PreparedArchiveEntry[] = []
  const errors: Array<{ path: string; reason: string }> = []
  const archivedPaths = new Set<string>()

  for (const path of paths) {
    const archivePath = archiveEntryPath(path.hash)
    if (archivedPaths.has(archivePath)) continue

    try {
      const stat = lstatSync(path.absolute)
      const mode = stat.mode & 0o7777
      if (stat.isSymbolicLink()) {
        const data = Uint8Array.from(
          readlinkSync(path.absolute, { encoding: "buffer" }),
        )
        entries.push({
          kind: "inline",
          archivePath,
          data,
          originalPath: path.original,
          expectedHash: path.hash,
          mode,
          mtimeMs: stat.mtimeMs,
          size: data.length,
        })
      } else if (stat.isFile()) {
        entries.push({
          kind: "file",
          archivePath,
          absolutePath: path.absolute,
          originalPath: path.original,
          expectedHash: path.hash,
          mode,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        })
      } else {
        errors.push({ path: path.original, reason: "Unsupported file type" })
        continue
      }
      archivedPaths.add(archivePath)
    } catch (e) {
      errors.push({
        path: path.original,
        reason: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return { entries, errors }
}

async function streamCompressedOutput(
  readable: ReadableStream<Uint8Array>,
  sink: UploadSink,
): Promise<number> {
  const reader = readable.getReader()
  let writtenBytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return writtenBytes
      await sink.write(value)
      writtenBytes += value.length
    }
  } catch (e) {
    await reader.cancel(e).catch(() => undefined)
    throw e
  }
}

export async function createArchive(
  paths: Array<{ original: string; absolute: string; hash: string }>,
  openSink: () => UploadSink,
): Promise<{
  size: number
  errors: Array<{ path: string; reason: string }>
}> {
  const { entries, errors } = prepareArchiveEntries(paths)
  if (errors.length > 0 || entries.length === 0) {
    return { size: 0, errors }
  }

  const sink = openSink()
  const compression = new CompressionStream("gzip")
  const output = streamCompressedOutput(compression.readable, sink)
  const writer = compression.writable.getWriter()

  try {
    for (const entry of entries) {
      if (entry.size > TAR_SIZE_MAX) {
        const paxData = createPaxRecord("size", String(entry.size))
        await writer.write(
          createTarHeader(entry, {
            archivePath: `PaxHeaders/${entry.expectedHash}`,
            size: paxData.length,
            typeFlag: 0x78,
          }),
        )
        await writer.write(paxData)
        const paxPadding =
          (TAR_BLOCK_SIZE - (paxData.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE
        if (paxPadding > 0) await writer.write(new Uint8Array(paxPadding))
      }

      await writer.write(
        createTarHeader(entry, {
          size: entry.size > TAR_SIZE_MAX ? 0 : entry.size,
        }),
      )
      let writtenBytes = 0
      const hasher = new Bun.CryptoHasher("sha256")

      if (entry.kind === "inline") {
        await writer.write(entry.data)
        hasher.update(entry.data)
        writtenBytes = entry.data.length
      } else {
        const reader = Bun.file(entry.absolutePath).stream().getReader()
        let result = await reader.read()
        while (!result.done) {
          await writer.write(result.value)
          hasher.update(result.value)
          writtenBytes += result.value.length
          result = await reader.read()
        }
      }

      if (writtenBytes !== entry.size) {
        throw new Error(
          `File changed while archiving ${entry.originalPath}: expected ${entry.size} bytes, read ${writtenBytes}`,
        )
      }
      const actualHash = hasher.digest("hex")
      if (actualHash !== entry.expectedHash) {
        throw new Error(
          `File changed while archiving ${entry.originalPath}: expected hash ${entry.expectedHash}, read ${actualHash}`,
        )
      }

      const padding =
        (TAR_BLOCK_SIZE - (entry.size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE
      if (padding > 0) await writer.write(new Uint8Array(padding))
    }

    await writer.write(new Uint8Array(TAR_BLOCK_SIZE * 2))
    await writer.close()
    const size = await output
    await sink.end()
    return { size, errors }
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e))
    await writer.abort(error).catch(() => undefined)
    await output.catch(() => undefined)
    await Promise.resolve(sink.end(error)).catch(() => undefined)
    throw error
  }
}

export async function extractArchive(
  archive: ReadableStream<Uint8Array>,
  targetDir: string,
): Promise<{ errors: Array<{ path: string; reason: string }> }> {
  const errors: Array<{ path: string; reason: string }> = []
  mkdirSync(targetDir, { recursive: true })

  const proc = Bun.spawn(["tar", "-xzf", "-", "-C", targetDir], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  })
  const reader = archive.getReader()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await proc.stdin.write(value)
    }
    await proc.stdin.end()
  } catch (e) {
    await reader.cancel(e).catch(() => undefined)
    await Promise.resolve(
      proc.stdin.end(e instanceof Error ? e : new Error(String(e))),
    ).catch(() => undefined)
  }

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = (await new Response(proc.stderr).text()).trim()
    errors.push({ path: targetDir, reason: `Extraction failed: ${stderr}` })
  }

  return { errors }
}
