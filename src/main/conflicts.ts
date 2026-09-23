import { statSync } from 'node:fs'
import {
  HeadObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput
} from '@aws-sdk/client-s3'
import { localPathFor } from './transferItems'

/** The slice of S3Client the checks need. */
export interface Sender {
  send(command: object, options?: { abortSignal?: AbortSignal }): Promise<unknown>
}

export interface Probe {
  /** whether an object with exactly this key exists */
  head(key: string): Promise<boolean>
  /** which of the wanted keys exist under the prefix */
  list(prefix: string, wanted: Set<string>): Promise<string[]>
}

export type TargetCheck = { head: string } | { list: string; keys: string[] }

/** HEADs run a few at a time, so a selection of loose files is not one round trip each. */
const PARALLEL_HEADS = 8

const statusOf = (err: unknown): number | undefined =>
  (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode

export function s3Probe(client: Sender, bucket: string): Probe {
  return {
    async head(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
        return true
      } catch (err) {
        const status = statusOf(err)
        // 404: not there. 403: what S3 answers for a missing key when the caller may not
        // list the bucket — typical for upload-only credentials — so it is no conflict either
        if (status === 404 || status === 403) return false
        throw err
      }
    },
    async list(prefix, wanted) {
      const found: string[] = []
      let token: string | undefined
      try {
        do {
          const res = (await client.send(
            new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token })
          )) as ListObjectsV2CommandOutput
          for (const o of res.Contents ?? []) if (o.Key && wanted.has(o.Key)) found.push(o.Key)
          token = res.IsTruncated ? res.NextContinuationToken : undefined
        } while (token)
      } catch (err) {
        // upload-only credentials may not list: nothing is known to clash, so nothing blocks
        if (statusOf(err) === 403) return found
        throw err
      }
      return found
    }
  }
}

/**
 * Group target keys so each selected folder costs one listing of its own prefix
 * and each loose file one HEAD — never a listing of everything under the target.
 */
export function targetChecks(prefix: string, keys: string[]): TargetCheck[] {
  const folders = new Map<string, string[]>()
  const checks: TargetCheck[] = []
  for (const key of keys) {
    const rest = key.slice(prefix.length)
    const cut = rest.indexOf('/')
    if (cut === -1) {
      checks.push({ head: key })
      continue
    }
    const folder = prefix + rest.slice(0, cut + 1)
    const group = folders.get(folder)
    if (group) group.push(key)
    else folders.set(folder, [key])
  }
  for (const [folder, group] of folders) checks.push({ list: folder, keys: group })
  return checks
}

export async function existingTargets(checks: TargetCheck[], probe: Probe): Promise<Set<string>> {
  const found = new Set<string>()
  const heads: string[] = []
  for (const check of checks) {
    if ('head' in check) heads.push(check.head)
    else for (const key of await probe.list(check.list, new Set(check.keys))) found.add(key)
  }
  for (let i = 0; i < heads.length; i += PARALLEL_HEADS) {
    const batch = heads.slice(i, i + PARALLEL_HEADS)
    const exists = await Promise.all(batch.map((key) => probe.head(key)))
    batch.forEach((key, j) => {
      if (exists[j]) found.add(key)
    })
  }
  return found
}

/**
 * Which download paths already exist locally. Keys that would land outside the
 * folder are no conflict: they fail with their own reason when they run.
 */
export function existingLocal(destDir: string, rels: string[]): Set<string> {
  const found = new Set<string>()
  for (const rel of rels) {
    let path: string
    try {
      path = localPathFor(destDir, rel)
    } catch {
      continue
    }
    try {
      statSync(path)
      found.add(rel)
    } catch {
      // not there yet
    }
  }
  return found
}
