import { AwsClient } from "aws4fetch"
import { S3Client } from "bun"
import type { R2Config } from "./types"

export type AssetMeta = {
  key: string
  size: number
  lastModified: string
}

export type UploadSink = {
  write(chunk: Uint8Array): number | Promise<number>
  end(error?: Error): number | Promise<number>
}

export function createClient(cfg: R2Config): AwsClient {
  return new AwsClient({
    accessKeyId: cfg.accessKeyId ?? "",
    secretAccessKey: cfg.secretAccessKey ?? "",
    service: "s3",
    region: "auto",
  })
}

function objectUrl(cfg: R2Config, key: string): string {
  const encoded = key.split("/").map(encodeURIComponent).join("/")
  return `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/${encoded}`
}

export async function uploadObject(
  cfg: R2Config,
  key: string,
  body: ArrayBuffer | Uint8Array | string,
  contentType: string,
): Promise<void> {
  const client = createClient(cfg)
  const url = objectUrl(cfg, key)
  const init: RequestInit = {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    },
    body,
  }
  const res = await client.fetch(url, init)
  if (!res.ok) {
    throw new Error(`R2 upload failed [${res.status}]: ${await res.text()}`)
  }
}

export function createUploadSink(
  cfg: R2Config,
  key: string,
  contentType: string,
): UploadSink {
  const client = new S3Client({
    accessKeyId: cfg.accessKeyId ?? "",
    secretAccessKey: cfg.secretAccessKey ?? "",
    bucket: cfg.bucket ?? "",
    endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    region: "auto",
    partSize: 5 * 1024 * 1024,
    queueSize: 1,
  })
  return client.file(key, { type: contentType }).writer()
}

export async function downloadObject(
  cfg: R2Config,
  key: string,
): Promise<ArrayBuffer> {
  const client = createClient(cfg)
  const url = objectUrl(cfg, key)
  const res = await client.fetch(url, { method: "GET" })
  if (!res.ok) {
    throw new Error(`R2 download failed [${res.status}]: ${await res.text()}`)
  }
  return res.arrayBuffer()
}

export async function downloadObjectStream(
  cfg: R2Config,
  key: string,
): Promise<{ stream: ReadableStream<Uint8Array>; size: number | null }> {
  const client = createClient(cfg)
  const url = objectUrl(cfg, key)
  const res = await client.fetch(url, { method: "GET" })
  if (!res.ok) {
    throw new Error(`R2 download failed [${res.status}]: ${await res.text()}`)
  }
  if (!res.body) {
    throw new Error("R2 download failed: response did not include a body")
  }
  const contentLength = res.headers.get("content-length")
  const size = contentLength === null ? null : Number(contentLength)
  return {
    stream: res.body,
    size: size !== null && Number.isFinite(size) ? size : null,
  }
}

export async function deleteObject(cfg: R2Config, key: string): Promise<void> {
  const client = createClient(cfg)
  const url = objectUrl(cfg, key)
  const res = await client.fetch(url, { method: "DELETE" })
  if (!res.ok) {
    throw new Error(`R2 delete failed [${res.status}]: ${await res.text()}`)
  }
}

export async function headObject(cfg: R2Config, key: string): Promise<boolean> {
  const client = createClient(cfg)
  const url = objectUrl(cfg, key)
  const res = await client.fetch(url, { method: "HEAD" })

  // 404 means object doesn't exist (expected case)
  if (res.status === 404) {
    return false
  }

  // 200-299 means object exists
  if (res.ok) {
    return true
  }

  // Other errors (403, 500, etc.) should be propagated
  throw new Error(`R2 HEAD request failed [${res.status}]: ${res.statusText}`)
}

function parseContents(xml: string): AssetMeta[] {
  const results: AssetMeta[] = []
  for (const block of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const c = block[1]
    if (!c) continue
    results.push({
      key: decodeXmlEntities(/<Key>(.*?)<\/Key>/.exec(c)?.[1] ?? ""),
      size: Number(/<Size>(.*?)<\/Size>/.exec(c)?.[1] ?? 0),
      lastModified: /<LastModified>(.*?)<\/LastModified>/.exec(c)?.[1] ?? "",
    })
  }
  return results
}

function nextToken(xml: string): string | null {
  const raw =
    /<NextContinuationToken>(.*?)<\/NextContinuationToken>/.exec(xml)?.[1] ??
    null
  return raw ? decodeXmlEntities(raw) : null
}

export async function listObjects(
  cfg: R2Config,
  prefix?: string,
): Promise<AssetMeta[]> {
  const client = createClient(cfg)
  const results: AssetMeta[] = []
  let token: string | null = null

  for (;;) {
    const params = new URLSearchParams({ "list-type": "2" })
    if (prefix) params.append("prefix", prefix)
    if (token) params.append("continuation-token", token)
    const url = `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}?${params.toString()}`
    const res = await client.fetch(url, { method: "GET" })
    if (!res.ok) {
      throw new Error(`R2 list failed [${res.status}]: ${await res.text()}`)
    }
    const xml = await res.text()
    results.push(...parseContents(xml))
    if (!xml.includes("<IsTruncated>true</IsTruncated>")) break
    token = nextToken(xml)
    if (!token) break
  }
  return results
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}
