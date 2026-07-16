import { AwsClient } from "aws4fetch"
import type { R2Config } from "./types"

export type AssetMeta = {
  key: string
  size: number
  lastModified: string
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

export async function deleteObject(cfg: R2Config, key: string): Promise<void> {
  const client = createClient(cfg)
  const url = objectUrl(cfg, key)
  const res = await client.fetch(url, { method: "DELETE" })
  if (!res.ok) {
    throw new Error(`R2 delete failed [${res.status}]: ${await res.text()}`)
  }
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
