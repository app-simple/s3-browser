import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { ConflictMode, JobKind, JobTarget } from '@shared/types'

export interface StoredItem {
  index: number
  name: string
  size: number
  data: unknown
}

export interface StoredJob {
  version: 1
  id: string
  kind: JobKind
  title: string
  target: JobTarget
  createdAt: number
  conflict: ConflictMode
  spec: unknown
  /** null for a job that lists its items as it goes (bucket sync) */
  items: StoredItem[] | null
}

export interface ItemOutcome {
  status: 'done' | 'skipped' | 'error' | 'cancelled'
  error?: string
}

export interface ResumeMark {
  items: number
  bytes: number
  key: string
}

export interface RestoredJob {
  job: StoredJob
  /** the user had paused this job when the app last ran */
  paused: boolean
  outcomes: Map<number, ItemOutcome>
  mark?: ResumeMark
}

export type QueueStore = ReturnType<typeof createQueueStore>

/** Job ids become file names, so only a safe alphabet is accepted. */
const ID = /^[A-Za-z0-9-]{1,64}$/
const KINDS = new Set(['upload', 'download', 'copy', 'sync'])

function isStoredJob(value: unknown): value is StoredJob {
  if (typeof value !== 'object' || value === null) return false
  const j = value as Record<string, unknown>
  const target = j.target as Record<string, unknown> | null | undefined
  return (
    j.version === 1 &&
    typeof j.id === 'string' &&
    ID.test(j.id) &&
    KINDS.has(j.kind as string) &&
    typeof j.title === 'string' &&
    typeof j.createdAt === 'number' &&
    (j.conflict === 'skip' || j.conflict === 'overwrite') &&
    typeof target === 'object' &&
    target !== null &&
    (target.type === 's3' || target.type === 'local') &&
    (j.items === null || Array.isArray(j.items))
  )
}

const oneLine = (text: string): string => text.replace(/[\r\n]+/g, ' ')

/**
 * Keeps unfinished jobs across restarts. A job's items are written once, when it
 * is created; after that only short lines are appended to its log, so a long job
 * never rewrites a large file and a crash costs at most the line being written.
 */
export function createQueueStore(dir: string) {
  function file(id: string, ext: 'job.json' | 'log'): string {
    if (!ID.test(id)) throw new Error(`Invalid job id: ${id}`)
    return join(dir, `${id}.${ext}`)
  }

  function ensureDir(): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  function append(id: string, line: string): void {
    ensureDir()
    appendFileSync(file(id, 'log'), `${line}\n`, { mode: 0o600 })
  }

  function remove(id: string): void {
    rmSync(file(id, 'job.json'), { force: true })
    rmSync(file(id, 'log'), { force: true })
  }

  function parse(line: string, into: RestoredJob): void {
    if (line === 'paused' || line === 'resumed') {
      into.paused = line === 'paused'
      return
    }
    const mark = /^mark (\d+) (\d+) (.+)$/.exec(line)
    if (mark) {
      try {
        const key: unknown = JSON.parse(mark[3])
        if (typeof key === 'string') into.mark = { items: Number(mark[1]), bytes: Number(mark[2]), key }
      } catch {
        // a malformed mark is ignored; the sync then starts from the previous one
      }
      return
    }
    const settled = /^(\d+) (done|skipped|error|cancelled)(?: (.*))?$/.exec(line)
    if (!settled) return
    const status = settled[2] as ItemOutcome['status']
    into.outcomes.set(
      Number(settled[1]),
      settled[3] === undefined ? { status } : { status, error: settled[3] }
    )
  }

  return {
    create(job: StoredJob): void {
      ensureDir()
      const target = file(job.id, 'job.json')
      const tmp = `${target}.tmp`
      writeFileSync(tmp, JSON.stringify(job), { mode: 0o600 })
      renameSync(tmp, target)
    },

    settle(id: string, index: number, outcome: ItemOutcome): void {
      const error = outcome.error === undefined ? '' : ` ${oneLine(outcome.error)}`
      append(id, `${index} ${outcome.status}${error}`)
    },

    paused(id: string, paused: boolean): void {
      append(id, paused ? 'paused' : 'resumed')
    },

    mark(id: string, mark: ResumeMark): void {
      append(id, `mark ${mark.items} ${mark.bytes} ${JSON.stringify(mark.key)}`)
    },

    remove,

    loadAll(): RestoredJob[] {
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        return []
      }
      const out: RestoredJob[] = []
      for (const name of names) {
        if (!name.endsWith('.job.json')) continue
        const id = name.slice(0, -'.job.json'.length)
        if (!ID.test(id)) continue
        let job: unknown
        try {
          job = JSON.parse(readFileSync(join(dir, name), 'utf8'))
        } catch {
          job = undefined
        }
        if (!isStoredJob(job) || job.id !== id) {
          remove(id)
          continue
        }
        const restored: RestoredJob = { job, paused: false, outcomes: new Map() }
        let log = ''
        try {
          log = readFileSync(file(id, 'log'), 'utf8')
        } catch {
          // no item had settled yet
        }
        const lines = log.split('\n')
        // the last element is '' after the final newline, or a line a crash cut short
        lines.pop()
        for (const line of lines) parse(line, restored)
        out.push(restored)
      }
      return out.sort((a, b) => a.job.createdAt - b.job.createdAt)
    }
  }
}
