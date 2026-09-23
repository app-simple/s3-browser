# Transfer-Warteschlange Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alle Übertragungen laufen über eine sichtbare, pausierbare, neustartfeste Warteschlange mit 4 Plätzen und fairer Verteilung; Upload und Download fragen bei vorhandenen Zielen einmal pro Auftrag.

**Architecture:** Ein reiner Scheduler (`transferQueue.ts`) verteilt Plätze an Aufträge, die jeweils eine Item-Quelle sind — vorab zerlegte Listen für Auswahl-Aufträge, seitenweise S3-Listung für den Bucket-Sync. `queueService.ts` verbindet Scheduler, Job-Fabrik und Speicher (`queueStore.ts`, Job-Datei einmal + Anhängeprotokoll). Der Renderer spricht zweistufig über `queue:plan` / `queue:enqueue`.

**Tech Stack:** Electron 44, TypeScript, React 19, AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/lib-storage`), Vitest 5.

**Spec:** `docs/superpowers/specs/2026-09-23-transfer-queue-design.md`

## Global Constraints

- Höchstens **4** Items gleichzeitig (`MAX_RUNNING = 4`), faire Verteilung reihum über Aufträge.
- Fortschritt an den Renderer gedrosselt auf **120 ms**; das Ende eines Auftrags wird sofort gesendet.
- Aufgeklappte Aufträge listen höchstens **8** wartende Items, danach „+ N more waiting".
- Queue-Dateien unter `userData/queue/`: Verzeichnis `0700`, Dateien `0600`; Job-Datei einmal geschrieben, danach nur Anhängeprotokoll.
- Keine Zugangsdaten in Queue-Dateien, nur Verbindungs-IDs. Download-Zielpfade werden bei jeder Ausführung über `localPathFor(destDir, rel)` neu berechnet.
- Jeder IPC-Kanal läuft durch `wrap()` in `src/main/ipc.ts` (Absenderprüfung) und validiert seine Argumente im Main-Prozess.
- UI-Texte englisch; Code, Kommentare und Commit-Messages englisch; Commits ohne Attribution-Zeilen.
- Keine neuen Runtime-Abhängigkeiten. Falls doch eine Abhängigkeit geändert wird: `npx -y npm@10.9.9 ci --ignore-scripts` in einer sauberen Kopie prüfen (CI nutzt Node 22 / npm 10).
- `npm test` läuft in CI auf macOS, Linux **und Windows**: Pfad-Erwartungen mit `path.join`/`path.resolve` bilden; Symlink- und Dateirechte-Tests mit `it.skipIf(process.platform === 'win32')`.
- Ende-zu-Ende-Skripte und der Fake-S3-HTTP-Server bleiben im Session-Scratchpad und werden **nicht** committet (sie nutzen `playwright-core` aus einem anderen Checkout).
- Abweichung vom Spec, bewusst: Die Builder/Runner kommen in ein neues Modul `src/main/transferItems.ts`; das alte `transfers.ts` wird in Task 5 gelöscht, statt zu schrumpfen. So bleibt jeder Zwischenstand baubar.

## Review Focus

1. **Auftrag mit zehntausenden Dateien** — das Panel darf nicht alle rendern; erwartet: höchstens 4 laufende und 8 wartende Items pro Auftrag in der Ansicht. → Test in Task 1.
2. **Upload-Zugangsdaten ohne Leserecht** (`HEAD` antwortet 403) — die Konfliktprüfung darf den Upload nicht blockieren; erwartet: kein Konflikt, Upload läuft. → Test in Task 8.
3. **Datei zwischen Planung und Ausführung gelöscht** — erwartet: nur dieses Item scheitert mit „The file no longer exists", ohne S3 zu kontaktieren. → Test in Task 3.
4. **Bucket-Sync eines leeren Ordners** — erwartet: der Auftrag endet sofort statt ewig zu warten. → Test in Task 2.
5. **Wiederherstellen-Leiste ignoriert, App erneut beendet** — erwartet: beim nächsten Start werden dieselben Aufträge wieder angeboten, nichts geht verloren. → Test in Task 7.

## Dateistruktur

| Datei | Verantwortung |
|---|---|
| `src/shared/types.ts` | Geteilte Typen: `JobKind`, `JobTarget`, `TransferJobView`, `QueueSnapshot`, `JobRequest`, `PlanSummary`, `JobDoneEvent` |
| `src/main/transferQueue.ts` (neu) | Scheduler: Plätze, Fairness, Pause, Abbruch, Ansicht; `arraySource` |
| `src/main/syncSource.ts` (neu) | Item-Quelle des Bucket-Syncs: seitenweise Listung, Fortsetz-Marke |
| `src/main/transferItems.ts` (neu) | Builder (Auswahl → Items) und Runner (ein Item übertragen), `localPathFor` |
| `src/main/jobRequest.ts` (neu) | Validierung der Renderer-Anfrage `queue:plan` |
| `src/main/jobFactory.ts` (neu) | Bindet Builder, Runner, Konfliktprüfung und S3-Clients an `JobFactory` |
| `src/main/queueService.ts` (neu) | Verbindet Scheduler, Fabrik und Speicher; Pläne, Drosselung, Wiederherstellen |
| `src/main/queueStore.ts` (neu) | Job-Datei + Anhängeprotokoll unter `userData/queue/` |
| `src/main/conflicts.ts` (neu) | Gezielte Zielprüfung (`HEAD` / Präfix-Listung / lokales `stat`) |
| `src/main/testing/fakeS3.ts` (neu) | Test-Hilfe: S3-Attrappe für List/Head/Get mit Request-Protokoll |
| `src/main/transfers.ts` | wird in Task 5 gelöscht |
| `src/main/ipc.ts`, `src/preload/index.ts` | `queue:*`-Kanäle statt `transfer:*` |
| `src/renderer/src/components/TransferPanel.tsx` | Aufträge gruppiert, Pause/Fortsetzen, Wiederherstellen-Leiste |
| `src/renderer/src/components/ConflictDialog.tsx` | Ziel als Beschriftung statt Bucket-Name |
| `src/renderer/src/App.tsx` | `startJob` (plan → Dialog → enqueue), `queue`-Zustand, Neuladen bei `jobDone` |

---

# Etappe 1 — Warteschlange und Oberfläche

### Task 1: Scheduler und geteilte Queue-Typen

**Files:**
- Modify: `src/shared/types.ts` (Typen ergänzen; die alten `Transfer*`-Typen bleiben bis Task 5)
- Create: `src/main/transferQueue.ts`
- Test: `src/main/transferQueue.test.ts`

**Interfaces:**
- Consumes: nichts.
- Produces:
  - `MAX_RUNNING = 4`, `UPCOMING_SHOWN = 8`
  - `interface QueueItem<T = unknown> { index: number; name: string; size: number; data: T }`
  - `type Take<T> = { item: QueueItem<T> } | { waiting: true } | { exhausted: true } | { error: string }`
  - `interface ItemSource<T = unknown> { take(): Take<T>; peek(n: number): QueueItem<T>[]; waiting(): number | null; totals(): { items: number | null; bytes: number | null }; drain(): number }`
  - `interface RunContext { signal: AbortSignal; onProgress(loaded: number): void }`
  - `class JobFailure extends Error`
  - `interface Settled { done: number; skipped: number; cancelled: number; bytes: number; failed: { item: QueueItem; error: string }[] }`
  - `interface JobInit<T = unknown> { id; kind: JobKind; title; target: JobTarget; createdAt: number; paused?: boolean; source: ItemSource<T>; run(item: QueueItem<T>, ctx: RunContext): Promise<'done' | 'skipped'>; settled?: Settled }`
  - `type SettledStatus = 'done' | 'skipped' | 'error' | 'cancelled'`
  - `interface QueueHooks { onChange?(): void; onItemSettled?(jobId, item, status: SettledStatus, error?): void; onJobFinished?(jobId): void; onJobPausedChanged?(jobId, paused): void }`
  - `createTransferQueue(hooks?: QueueHooks)` → `{ add, wake, pauseAll, resumeAll, pauseJob, resumeJob, cancelJob, cancelItem, clearFinished, has(id): boolean, isPaused(): boolean, view(): TransferJobView[] }`
  - `arraySource<T>(items: QueueItem<T>[], alreadySettled?: { items: number; bytes: number }): ItemSource<T>`

- [ ] **Step 1: Geteilte Typen ergänzen**

An das Ende von `src/shared/types.ts` anhängen:

```ts
export type JobKind = 'upload' | 'download' | 'copy' | 'sync'
export type ItemStatus = 'queued' | 'running' | 'done' | 'skipped' | 'error' | 'cancelled'
export type ConflictMode = 'skip' | 'overwrite'

/** Where a job writes; the renderer uses it to refresh the open folder when the job ends. */
export type JobTarget =
  | { type: 's3'; accountId: string; bucket: string; prefix: string }
  | { type: 'local'; dir: string }

export interface TransferItemView {
  index: number
  name: string
  size: number
  loaded: number
  status: ItemStatus
  error?: string
}

/** A job as the transfer panel sees it: totals plus the few items worth listing. */
export interface TransferJobView {
  id: string
  kind: JobKind
  title: string
  target: JobTarget
  createdAt: number
  paused: boolean
  finished: boolean
  /** set when the job as a whole gave up, e.g. its connection was deleted */
  error?: string
  items: {
    /** null while a bucket sync is still being counted */
    total: number | null
    /** null while a bucket sync is still listing */
    waiting: number | null
    running: number
    done: number
    skipped: number
    failed: number
    cancelled: number
  }
  bytes: { total: number | null; done: number }
  running: TransferItemView[]
  failed: TransferItemView[]
  upcoming: TransferItemView[]
}

export interface QueueSnapshot {
  paused: boolean
  jobs: TransferJobView[]
  /** unfinished jobs from the previous session, waiting for Resume or Discard */
  restore: { jobs: number; items: number } | null
}

export interface EntryRef {
  key: string
  type: 'file' | 'folder'
  size?: number
}

export interface S3Location {
  accountId: string
  bucket: string
  prefix: string
}

/** What the renderer asks the queue to transfer. */
export type JobRequest =
  | { kind: 'upload'; accountId: string; bucket: string; prefix: string; paths: string[] }
  | { kind: 'download'; accountId: string; bucket: string; entries: EntryRef[]; destDir: string }
  | { kind: 'copy'; accountId: string; bucket: string; entries: EntryRef[]; target: S3Location }
  | { kind: 'sync'; accountId: string; bucket: string; prefix: string; target: S3Location }

export interface PlanSummary {
  planId: string
  /** null for a bucket sync, whose items are listed while it runs */
  total: number | null
  conflicts: number
  sample: string[]
}

export interface JobDoneEvent {
  jobId: string
  kind: JobKind
  target: JobTarget
}
```

- [ ] **Step 2: Tests schreiben**

`src/main/transferQueue.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import {
  arraySource,
  createTransferQueue,
  JobFailure,
  type ItemSource,
  type JobInit,
  type QueueItem,
  type RunContext
} from './transferQueue'

const items = (n: number, size = 10): QueueItem<string>[] =>
  Array.from({ length: n }, (_, index) => ({ index, name: `f${index}`, size, data: `f${index}` }))

/** A runner whose items finish only when the test says so. */
function manual() {
  const live = new Map<
    number,
    { finish(result?: 'done' | 'skipped'): void; fail(err: unknown): void; ctx: RunContext }
  >()
  const started: number[] = []
  const run = (item: QueueItem, ctx: RunContext) =>
    new Promise<'done' | 'skipped'>((resolve, reject) => {
      started.push(item.index)
      live.set(item.index, {
        finish: (result = 'done') => {
          live.delete(item.index)
          resolve(result)
        },
        fail: (err) => {
          live.delete(item.index)
          reject(err)
        },
        ctx
      })
      ctx.signal.addEventListener('abort', () => {
        live.delete(item.index)
        reject(new Error('aborted'))
      })
    })
  return { run, live, started }
}

/** let the queue's promise callbacks run */
const settle = () => new Promise((r) => setTimeout(r, 0))

function job(
  id: string,
  n: number,
  runner: ReturnType<typeof manual>,
  extra: Partial<JobInit> = {}
): JobInit {
  return {
    id,
    kind: 'upload',
    title: id,
    target: { type: 'local', dir: '/tmp' },
    createdAt: 0,
    source: arraySource(items(n)),
    run: runner.run,
    ...extra
  }
}

describe('transfer queue', () => {
  it('never runs more than four items at once', async () => {
    const a = manual()
    const queue = createTransferQueue()

    queue.add(job('a', 10, a))
    expect(a.live.size).toBe(4)
    a.live.get(0)!.finish()
    await settle()

    expect(a.live.size).toBe(4)
    expect(a.started).toEqual([0, 1, 2, 3, 4])
  })

  it('gives the next free slot to a job added later', async () => {
    const a = manual()
    const b = manual()
    const queue = createTransferQueue()
    queue.add(job('a', 10, a))
    queue.add(job('b', 1, b))
    expect(b.started).toEqual([])

    a.live.get(0)!.finish()
    await settle()

    expect(b.started).toEqual([0])
  })

  it('starts nothing new while paused but lets running items finish', async () => {
    const a = manual()
    const queue = createTransferQueue()
    queue.add(job('a', 10, a))

    queue.pauseAll()
    a.live.get(0)!.finish()
    a.live.get(1)!.finish()
    await settle()
    expect(a.live.size).toBe(2)

    queue.resumeAll()
    expect(a.live.size).toBe(4)
  })

  it('skips a paused job and gives its slots to the others', async () => {
    const a = manual()
    const b = manual()
    const queue = createTransferQueue()
    queue.add(job('a', 10, a))
    queue.add(job('b', 10, b))

    queue.pauseJob('a')
    for (const index of [...a.live.keys()]) a.live.get(index)!.finish()
    await settle()

    expect(a.live.size).toBe(0)
    expect(b.live.size).toBe(4)
  })

  it('stops the running items and drops the waiting ones of a cancelled job', async () => {
    const a = manual()
    const finished = vi.fn()
    const queue = createTransferQueue({ onJobFinished: finished })
    queue.add(job('a', 10, a))

    queue.cancelJob('a')
    await settle()

    const [view] = queue.view()
    expect(view.items).toMatchObject({ cancelled: 10, done: 0, waiting: 0 })
    expect(view.finished).toBe(true)
    expect(finished).toHaveBeenCalledTimes(1)
  })

  it('cancels a single running item and moves on', async () => {
    const a = manual()
    const queue = createTransferQueue()
    queue.add(job('a', 5, a))

    queue.cancelItem('a', 1)
    await settle()

    expect(queue.view()[0].items).toMatchObject({ cancelled: 1, running: 4 })
    expect(a.started).toEqual([0, 1, 2, 3, 4])
  })

  it('keeps going after one item fails', async () => {
    const a = manual()
    const queue = createTransferQueue()
    queue.add(job('a', 3, a))

    a.live.get(0)!.fail(new Error('Access Denied'))
    a.live.get(1)!.finish()
    a.live.get(2)!.finish()
    await settle()

    const [view] = queue.view()
    expect(view.items).toMatchObject({ done: 2, failed: 1 })
    expect(view.failed).toMatchObject([{ index: 0, status: 'error', error: 'Access Denied' }])
    expect(view.finished).toBe(true)
  })

  it('ends the whole job when a runner reports a job failure', async () => {
    const a = manual()
    const finished = vi.fn()
    const queue = createTransferQueue({ onJobFinished: finished })
    queue.add(job('a', 10, a))

    a.live.get(0)!.fail(new JobFailure('The connection used by this job no longer exists'))
    await settle()

    const [view] = queue.view()
    expect(view.error).toBe('The connection used by this job no longer exists')
    expect(view.finished).toBe(true)
    expect(a.started).toEqual([0, 1, 2, 3])
    expect(finished).toHaveBeenCalledTimes(1)
  })

  it('counts an item the runner skipped as skipped', async () => {
    const a = manual()
    const queue = createTransferQueue()
    queue.add(job('a', 1, a))

    a.live.get(0)!.finish('skipped')
    await settle()

    expect(queue.view()[0].items).toMatchObject({ done: 0, skipped: 1 })
  })

  it('reports a job finished when its last item ends while everything is paused', async () => {
    const a = manual()
    const finished = vi.fn()
    const queue = createTransferQueue({ onJobFinished: finished })
    queue.add(job('a', 1, a))

    queue.pauseAll()
    a.live.get(0)!.finish()
    await settle()

    expect(finished).toHaveBeenCalledWith('a')
  })

  it('finishes a job at once when all of its items were settled beforehand', () => {
    const finished = vi.fn()
    const queue = createTransferQueue({ onJobFinished: finished })

    queue.add(
      job('a', 0, manual(), {
        settled: { done: 0, skipped: 3, cancelled: 0, bytes: 30, failed: [] }
      })
    )

    expect(finished).toHaveBeenCalledWith('a')
  })

  it('asks a source that was still listing again once it wakes the queue', () => {
    const a = manual()
    let ready: QueueItem[] = []
    const source: ItemSource = {
      take: () => {
        const item = ready.shift()
        return item ? { item } : { waiting: true }
      },
      peek: () => [],
      waiting: () => null,
      totals: () => ({ items: null, bytes: null }),
      drain: () => 0
    }
    const queue = createTransferQueue()
    queue.add(job('a', 0, a, { source }))
    expect(a.started).toEqual([])

    ready = items(2)
    queue.wake()

    expect(a.started).toEqual([0, 1])
  })

  it('lists only a handful of the waiting items of a very large job', () => {
    const queue = createTransferQueue()

    queue.add(job('a', 50_000, manual()))

    const [view] = queue.view()
    expect(view.running).toHaveLength(4)
    expect(view.upcoming.map((i) => i.index)).toEqual([4, 5, 6, 7, 8, 9, 10, 11])
    expect(view.items).toMatchObject({ total: 50_000, waiting: 49_996 })
  })

  it('includes the progress of running items in the byte count', async () => {
    const a = manual()
    const queue = createTransferQueue()
    queue.add(job('a', 2, a))

    a.live.get(0)!.ctx.onProgress(4)
    a.live.get(1)!.finish()
    await settle()

    expect(queue.view()[0].bytes).toEqual({ total: 20, done: 14 })
  })

  it('treats a runner that throws right away like a failed item', async () => {
    const queue = createTransferQueue()
    let calls = 0
    queue.add(
      job('a', 2, manual(), {
        run: () => {
          calls++
          throw new Error('boom')
        }
      })
    )
    await settle()

    expect(calls).toBe(2)
    expect(queue.view()[0].items).toMatchObject({ failed: 2, running: 0 })
  })

  it('clears finished jobs and keeps the others', async () => {
    const a = manual()
    const b = manual()
    const queue = createTransferQueue()
    queue.add(job('a', 1, a))
    queue.add(job('b', 1, b))

    a.live.get(0)!.finish()
    await settle()
    queue.clearFinished()

    expect(queue.view().map((j) => j.id)).toEqual(['b'])
    expect(queue.has('a')).toBe(false)
  })
})
```

- [ ] **Step 3: Tests laufen lassen, Fehlschlag prüfen**

Run: `npx vitest run src/main/transferQueue.test.ts`
Expected: FAIL — `Failed to resolve import "./transferQueue"`. Danach das Modul mit einem Stub anlegen (`export function createTransferQueue() { return {} as never }` usw.), bis die Tests an Assertions scheitern statt am Import.

- [ ] **Step 4: Scheduler implementieren**

`src/main/transferQueue.ts`:

```ts
import type {
  JobKind,
  JobTarget,
  TransferItemView,
  TransferJobView
} from '@shared/types'

/** How many items transfer at the same time, across all jobs. */
export const MAX_RUNNING = 4
/** How many waiting items a job lists in the panel before summarising the rest. */
export const UPCOMING_SHOWN = 8
/** Failed items listed per job; the count covers any beyond. */
const FAILED_SHOWN = 50

export interface QueueItem<T = unknown> {
  index: number
  name: string
  size: number
  data: T
}

export type Take<T> =
  | { item: QueueItem<T> }
  | { waiting: true }
  | { exhausted: true }
  | { error: string }

/** Where a job's items come from. The scheduler only ever asks for the next one. */
export interface ItemSource<T = unknown> {
  take(): Take<T>
  peek(n: number): QueueItem<T>[]
  /** items known to be waiting, or null while that is not known yet */
  waiting(): number | null
  /** size of the whole job, settled items included */
  totals(): { items: number | null; bytes: number | null }
  /** drop every waiting item and return how many there were */
  drain(): number
}

export interface RunContext {
  signal: AbortSignal
  onProgress(loaded: number): void
}

/** Thrown by a runner when the job as a whole cannot go on, e.g. its connection is gone. */
export class JobFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JobFailure'
  }
}

/** Items accounted for before a job was added: skipped while planning, finished before a restart. */
export interface Settled {
  done: number
  skipped: number
  cancelled: number
  /** bytes of the done and skipped items */
  bytes: number
  failed: { item: QueueItem; error: string }[]
}

export interface JobInit<T = unknown> {
  id: string
  kind: JobKind
  title: string
  target: JobTarget
  createdAt: number
  paused?: boolean
  source: ItemSource<T>
  run(item: QueueItem<T>, ctx: RunContext): Promise<'done' | 'skipped'>
  settled?: Settled
}

export type SettledStatus = 'done' | 'skipped' | 'error' | 'cancelled'

export interface QueueHooks {
  /** anything visible changed; the caller decides how often to redraw */
  onChange?(): void
  onItemSettled?(jobId: string, item: QueueItem, status: SettledStatus, error?: string): void
  onJobFinished?(jobId: string): void
  onJobPausedChanged?(jobId: string, paused: boolean): void
}

interface Running {
  item: QueueItem
  loaded: number
  controller: AbortController
}

interface JobState {
  init: JobInit
  paused: boolean
  cancelled: boolean
  error?: string
  finished: boolean
  running: Map<number, Running>
  failed: { item: QueueItem; error: string }[]
  done: number
  skipped: number
  cancelledCount: number
  bytesDone: number
}

/** A job whose items are all known up front: a selection of files, folders or objects. */
export function arraySource<T>(
  items: QueueItem<T>[],
  alreadySettled: { items: number; bytes: number } = { items: 0, bytes: 0 }
): ItemSource<T> {
  let next = 0
  const bytes = items.reduce((sum, i) => sum + i.size, 0)
  return {
    take: () => (next < items.length ? { item: items[next++] } : { exhausted: true }),
    peek: (n) => items.slice(next, next + n),
    waiting: () => items.length - next,
    totals: () => ({
      items: items.length + alreadySettled.items,
      bytes: bytes + alreadySettled.bytes
    }),
    drain: () => {
      const left = items.length - next
      next = items.length
      return left
    }
  }
}

const itemView = (item: QueueItem, status: TransferItemView['status'], loaded = 0, error?: string): TransferItemView => ({
  index: item.index,
  name: item.name,
  size: item.size,
  loaded,
  status,
  ...(error === undefined ? {} : { error })
})

export function createTransferQueue(hooks: QueueHooks = {}) {
  const jobs: JobState[] = []
  let paused = false
  let running = 0
  /** the job that got the last slot; the next slot goes to the one after it */
  let lastServed: string | undefined

  const changed = (): void => hooks.onChange?.()
  const find = (id: string): JobState | undefined => jobs.find((j) => j.init.id === id)
  const active = (job: JobState): boolean => !job.finished && !job.cancelled && !job.error

  function finishIfIdle(job: JobState): void {
    if (job.finished || job.running.size > 0) return
    if (active(job) && job.init.source.waiting() !== 0) return
    job.finished = true
    hooks.onJobFinished?.(job.init.id)
  }

  function fail(job: JobState, message: string): void {
    if (job.error) return
    job.error = message
    job.cancelledCount += job.init.source.drain()
    for (const r of job.running.values()) r.controller.abort()
    finishIfIdle(job)
  }

  function pickNext(): { job: JobState; item: QueueItem } | undefined {
    if (jobs.length === 0) return undefined
    const start = lastServed === undefined ? 0 : jobs.findIndex((j) => j.init.id === lastServed) + 1
    for (let step = 0; step < jobs.length; step++) {
      const job = jobs[(start + step) % jobs.length]
      if (!active(job) || job.paused) continue
      const took = job.init.source.take()
      if ('item' in took) {
        lastServed = job.init.id
        return { job, item: took.item }
      }
      if ('error' in took) fail(job, took.error)
      else if ('exhausted' in took) finishIfIdle(job)
    }
    return undefined
  }

  function pump(): void {
    if (paused) return
    while (running < MAX_RUNNING) {
      const next = pickNext()
      if (!next) break
      start(next.job, next.item)
    }
  }

  function start(job: JobState, item: QueueItem): void {
    const controller = new AbortController()
    const entry: Running = { item, loaded: 0, controller }
    job.running.set(item.index, entry)
    running++
    changed()
    const ctx: RunContext = {
      signal: controller.signal,
      onProgress: (loaded) => {
        entry.loaded = loaded
        changed()
      }
    }
    let result: Promise<'done' | 'skipped'>
    try {
      result = job.init.run(item, ctx)
    } catch (err) {
      // a runner that throws before returning its promise must not break the dispatch loop
      result = Promise.reject(err)
    }
    result.then(
        (result) => settle(job, entry, result === 'skipped' ? 'skipped' : 'done'),
        (err: unknown) => {
          if (controller.signal.aborted) return settle(job, entry, 'cancelled')
          const message = err instanceof Error ? err.message : String(err)
          if (err instanceof JobFailure) fail(job, message)
          settle(job, entry, 'error', message)
        }
      )
  }

  function settle(job: JobState, entry: Running, status: SettledStatus, error?: string): void {
    job.running.delete(entry.item.index)
    running--
    if (status === 'done') {
      job.done++
      job.bytesDone += entry.item.size
    } else if (status === 'skipped') {
      job.skipped++
      job.bytesDone += entry.item.size
    } else if (status === 'cancelled') {
      job.cancelledCount++
    } else {
      job.failed.push({ item: entry.item, error: error ?? 'Unknown error' })
    }
    hooks.onItemSettled?.(job.init.id, entry.item, status, error)
    finishIfIdle(job)
    changed()
    pump()
  }

  function viewOf(job: JobState): TransferJobView {
    const live = active(job)
    const totals = job.init.source.totals()
    const runningItems = [...job.running.values()]
    return {
      id: job.init.id,
      kind: job.init.kind,
      title: job.init.title,
      target: job.init.target,
      createdAt: job.init.createdAt,
      paused: job.paused,
      finished: job.finished,
      ...(job.error === undefined ? {} : { error: job.error }),
      items: {
        total: totals.items,
        waiting: live ? job.init.source.waiting() : 0,
        running: runningItems.length,
        done: job.done,
        skipped: job.skipped,
        failed: job.failed.length,
        cancelled: job.cancelledCount
      },
      bytes: {
        total: totals.bytes,
        done: job.bytesDone + runningItems.reduce((sum, r) => sum + r.loaded, 0)
      },
      running: runningItems.map((r) => itemView(r.item, 'running', r.loaded)),
      failed: job.failed.slice(0, FAILED_SHOWN).map((f) => itemView(f.item, 'error', 0, f.error)),
      upcoming: live ? job.init.source.peek(UPCOMING_SHOWN).map((i) => itemView(i, 'queued')) : []
    }
  }

  return {
    add<T>(init: JobInit<T>): void {
      const s = init.settled
      const job: JobState = {
        init: init as unknown as JobInit,
        paused: init.paused ?? false,
        cancelled: false,
        finished: false,
        running: new Map(),
        failed: s ? [...s.failed] : [],
        done: s?.done ?? 0,
        skipped: s?.skipped ?? 0,
        cancelledCount: s?.cancelled ?? 0,
        bytesDone: s?.bytes ?? 0
      }
      jobs.push(job)
      // a job whose items were all settled while planning is done at once
      finishIfIdle(job)
      changed()
      pump()
    },
    /** a source that answered "waiting" has items again */
    wake(): void {
      pump()
    },
    pauseAll(): void {
      paused = true
      changed()
    },
    resumeAll(): void {
      paused = false
      changed()
      pump()
    },
    pauseJob(id: string): void {
      const job = find(id)
      if (!job || job.paused || job.finished) return
      job.paused = true
      hooks.onJobPausedChanged?.(id, true)
      changed()
    },
    resumeJob(id: string): void {
      const job = find(id)
      if (!job || !job.paused) return
      job.paused = false
      hooks.onJobPausedChanged?.(id, false)
      changed()
      pump()
    },
    cancelJob(id: string): void {
      const job = find(id)
      if (!job || job.finished || job.cancelled) return
      job.cancelled = true
      job.cancelledCount += job.init.source.drain()
      for (const r of job.running.values()) r.controller.abort()
      finishIfIdle(job)
      changed()
    },
    cancelItem(jobId: string, index: number): void {
      find(jobId)?.running.get(index)?.controller.abort()
    },
    clearFinished(): void {
      for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].finished) jobs.splice(i, 1)
      changed()
    },
    has: (id: string): boolean => find(id) !== undefined,
    isPaused: (): boolean => paused,
    view: (): TransferJobView[] => jobs.map(viewOf)
  }
}
```

- [ ] **Step 5: Tests laufen lassen**

Run: `npx vitest run src/main/transferQueue.test.ts`
Expected: PASS (16 Tests). Danach `npm test` und `npm run typecheck` — beide grün.

- [ ] **Step 6: Mutationsprüfung**

Einzeln ausprobieren und jeweils zurücksetzen; mindestens ein Test muss scheitern:
- in `pickNext` `lastServed = job.init.id` entfernen → „gives the next free slot…" scheitert;
- in `finishIfIdle` die Zeile `if (active(job) && …) return` entfernen → „…while everything is paused" bzw. „never runs more than four" scheitern;
- in `pump` `if (paused) return` entfernen → „starts nothing new while paused…" scheitert.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/main/transferQueue.ts src/main/transferQueue.test.ts
git commit -m "Add a transfer queue scheduler with fair slots, pause and cancel"
```

### Task 2: Item-Quelle für den Bucket-Sync

**Files:**
- Create: `src/main/testing/fakeS3.ts` (gemeinsame Test-Attrappe; ersetzt die lokale Kopie in `prefixScan.test.ts`)
- Modify: `src/main/prefixScan.test.ts` (nutzt die gemeinsame Attrappe)
- Create: `src/main/syncSource.ts`
- Test: `src/main/syncSource.test.ts`

**Interfaces:**
- Consumes: `ItemSource`, `QueueItem`, `Take`, `createTransferQueue` (Task 1); `ListClient` aus `src/main/prefixScan.ts`.
- Produces:
  - `fakeS3(objects: FakeObject[], opts?: FakeS3Options)` → `{ requests: FakeRequest[]; send }` mit `FakeRequest = { command: 'list' | 'head' | 'get'; input: object }`; `httpError(status, name, message): Error`
  - `interface SyncEntry { key: string }`
  - `interface ListingSource extends ItemSource<SyncEntry> { setTotals(items: number, bytes: number): void; settle(index: number): string | undefined }`
  - `listingSource(opts: { client: () => ListClient; bucket: string; prefix: string; startAfter?: string; wake(): void }): ListingSource`

- [ ] **Step 1: Gemeinsame S3-Attrappe anlegen**

`src/main/testing/fakeS3.ts`:

```ts
import { Readable } from 'node:stream'
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
  type ListObjectsV2CommandOutput
} from '@aws-sdk/client-s3'

export interface FakeObject {
  key: string
  size: number
  /** content served by GetObject; defaults to `size` bytes of "x" */
  body?: string
}

export interface FakeS3Options {
  /** keys per listing page; S3 may return fewer than MaxKeys, so callers must follow IsTruncated */
  pageSize?: number
  /** answer after this many ms; Infinity never answers until the request is aborted */
  delayMs?: number
  /** every request fails with this error */
  failWith?: Error
  /** HeadObject answers with this HTTP status instead of looking the key up */
  headStatus?: number
}

export interface FakeRequest {
  command: 'list' | 'head' | 'get'
  input: object
}

/** An error shaped the way the SDK throws one for an HTTP status. */
export function httpError(status: number, name: string, message: string): Error {
  return Object.assign(new Error(message), {
    name,
    $fault: status >= 500 ? 'server' : 'client',
    $metadata: { httpStatusCode: status }
  })
}

const aborted = (): Error => Object.assign(new Error('Request aborted'), { name: 'AbortError' })

/**
 * Stands in for the network: answers ListObjectsV2, HeadObject and GetObject the
 * way S3 does — prefix filtering, delimiter grouping, StartAfter, lexicographic
 * order and paging through continuation tokens — and records every request.
 */
export function fakeS3(objects: FakeObject[], opts: FakeS3Options = {}) {
  const requests: FakeRequest[] = []
  const sorted = [...objects].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  async function wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw aborted()
    if (opts.failWith) throw opts.failWith
    if (!opts.delayMs) return
    await new Promise<void>((resolve, reject) => {
      if (Number.isFinite(opts.delayMs)) setTimeout(resolve, opts.delayMs)
      signal?.addEventListener('abort', () => reject(aborted()))
    })
  }

  function list(input: ListObjectsV2Command['input']): ListObjectsV2CommandOutput {
    const prefix = input.Prefix ?? ''
    // StartAfter only applies to the first page; later pages continue from the token
    const after = input.ContinuationToken ? undefined : input.StartAfter
    const rows: ({ obj: FakeObject } | { common: string })[] = []
    const seen = new Set<string>()
    for (const o of sorted) {
      if (!o.key.startsWith(prefix)) continue
      if (after !== undefined && o.key <= after) continue
      const rest = o.key.slice(prefix.length)
      const cut = input.Delimiter ? rest.indexOf(input.Delimiter) : -1
      if (cut === -1) {
        rows.push({ obj: o })
      } else {
        const common = prefix + rest.slice(0, cut + 1)
        if (!seen.has(common)) {
          seen.add(common)
          rows.push({ common })
        }
      }
    }
    const start = input.ContinuationToken ? Number(input.ContinuationToken.slice('tok-'.length)) : 0
    const limit = Math.min(opts.pageSize ?? 1000, input.MaxKeys ?? 1000)
    const page = rows.slice(start, start + limit)
    const next = start + limit
    const truncated = next < rows.length
    const contents = page.flatMap((r) =>
      'obj' in r
        ? [
            {
              Key: r.obj.key,
              LastModified: new Date('2026-01-01T00:00:00Z'),
              ETag: '"d41d8cd98f00b204e9800998ecf8427e"',
              Size: r.obj.size,
              StorageClass: 'STANDARD' as const
            }
          ]
        : []
    )
    const commons = page.flatMap((r) => ('common' in r ? [{ Prefix: r.common }] : []))
    return {
      $metadata: { httpStatusCode: 200 },
      IsTruncated: truncated,
      // S3 leaves these out entirely rather than sending empty arrays
      ...(contents.length ? { Contents: contents } : {}),
      ...(commons.length ? { CommonPrefixes: commons } : {}),
      Name: input.Bucket,
      Prefix: prefix,
      Delimiter: input.Delimiter,
      MaxKeys: input.MaxKeys ?? 1000,
      KeyCount: page.length,
      ContinuationToken: input.ContinuationToken,
      ...(truncated ? { NextContinuationToken: `tok-${next}` } : {})
    }
  }

  function find(key: string | undefined): FakeObject {
    const o = sorted.find((x) => x.key === key)
    if (!o) throw httpError(404, 'NotFound', 'Not Found')
    return o
  }

  function send(
    command: ListObjectsV2Command,
    options?: { abortSignal?: AbortSignal }
  ): Promise<ListObjectsV2CommandOutput>
  function send(
    command: HeadObjectCommand,
    options?: { abortSignal?: AbortSignal }
  ): Promise<HeadObjectCommandOutput>
  function send(
    command: GetObjectCommand,
    options?: { abortSignal?: AbortSignal }
  ): Promise<GetObjectCommandOutput>
  function send(command: object, options?: { abortSignal?: AbortSignal }): Promise<unknown>
  async function send(command: object, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    if (command instanceof ListObjectsV2Command) {
      requests.push({ command: 'list', input: { ...command.input } })
      await wait(options?.abortSignal)
      return list(command.input)
    }
    if (command instanceof HeadObjectCommand) {
      requests.push({ command: 'head', input: { ...command.input } })
      await wait(options?.abortSignal)
      if (opts.headStatus) {
        throw httpError(opts.headStatus, opts.headStatus === 403 ? 'Forbidden' : 'Unknown', `HTTP ${opts.headStatus}`)
      }
      const o = find(command.input.Key)
      return { $metadata: { httpStatusCode: 200 }, ContentLength: o.size, ETag: '"etag"' }
    }
    if (command instanceof GetObjectCommand) {
      requests.push({ command: 'get', input: { ...command.input } })
      await wait(options?.abortSignal)
      const o = find(command.input.Key)
      const body = o.body ?? 'x'.repeat(o.size)
      return {
        $metadata: { httpStatusCode: 200 },
        ContentLength: Buffer.byteLength(body),
        Body: Readable.from([Buffer.from(body)])
      }
    }
    throw new Error(`fakeS3 does not handle ${command.constructor.name}`)
  }

  return { requests, send }
}
```

- [ ] **Step 2: `prefixScan.test.ts` auf die gemeinsame Attrappe umstellen**

In `src/main/prefixScan.test.ts`:
1. Den lokalen Block von `type Obj = { key: string; size: number }` bis einschließlich der schließenden `}` der Funktion `fakeS3` löschen.
2. Den Import `import { ListObjectsV2Command, type ListObjectsV2CommandInput } from '@aws-sdk/client-s3'` ersetzen durch `import { fakeS3 } from './testing/fakeS3'`.
3. Aufrufe anpassen — jede Stelle, an der als zweites Argument die Seitengröße steht:
   - `],\n      2\n    )` → `],\n      { pageSize: 2 }\n    )` (fünf Stellen)
   - `, 1000, { delayMs: Infinity })` → `, { delayMs: Infinity })`
   - `, 1000, { delayMs: 60 })` → `, { delayMs: 60 })` (zwei Stellen)
   - `fakeS3([], 1000, { failWith: denied })` → `fakeS3([], { failWith: denied })`

Run: `npx vitest run src/main/prefixScan.test.ts`
Expected: PASS (15 Tests) — dieselben Tests, jetzt gegen die gemeinsame Attrappe.

- [ ] **Step 3: Tests für die Sync-Quelle schreiben**

`src/main/syncSource.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { fakeS3, httpError } from './testing/fakeS3'
import { listingSource } from './syncSource'
import { createTransferQueue } from './transferQueue'

const settle = () => new Promise((r) => setTimeout(r, 0))

/** Take items until the source is exhausted, letting pages arrive in between. */
async function drainKeys(source: ReturnType<typeof listingSource>): Promise<string[]> {
  const keys: string[] = []
  for (let guard = 0; guard < 50; guard++) {
    const took = source.take()
    if ('item' in took) keys.push(took.item.data.key)
    else if ('exhausted' in took) return keys
    else await settle()
  }
  throw new Error('source never finished')
}

describe('listing source', () => {
  it('hands out every object under the prefix, a page at a time', async () => {
    const s3 = fakeS3(
      [
        { key: 'src/a', size: 1 },
        { key: 'src/b', size: 2 },
        { key: 'src/c', size: 3 },
        { key: 'other/x', size: 9 }
      ],
      { pageSize: 2 }
    )
    const source = listingSource({ client: () => s3, bucket: 'b', prefix: 'src/', wake: () => {} })

    expect(await drainKeys(source)).toEqual(['src/a', 'src/b', 'src/c'])
    expect(s3.requests.filter((r) => r.command === 'list')).toHaveLength(2)
  })

  it('leaves out folder placeholders', async () => {
    const s3 = fakeS3([
      { key: 'src/', size: 0 },
      { key: 'src/a', size: 1 }
    ])
    const source = listingSource({ client: () => s3, bucket: 'b', prefix: 'src/', wake: () => {} })

    expect(await drainKeys(source)).toEqual(['src/a'])
  })

  it('continues after the mark of a previous run', async () => {
    const s3 = fakeS3([
      { key: 'src/a', size: 1 },
      { key: 'src/b', size: 1 },
      { key: 'src/c', size: 1 }
    ])
    const source = listingSource({
      client: () => s3,
      bucket: 'b',
      prefix: 'src/',
      startAfter: 'src/b',
      wake: () => {}
    })

    expect(await drainKeys(source)).toEqual(['src/c'])
  })

  it('moves the resume mark only past items that have all settled', async () => {
    const s3 = fakeS3([
      { key: 'k/a', size: 1 },
      { key: 'k/b', size: 1 },
      { key: 'k/c', size: 1 }
    ])
    const source = listingSource({ client: () => s3, bucket: 'b', prefix: 'k/', wake: () => {} })
    source.take()
    await settle()
    const taken = [source.take(), source.take(), source.take()].map((t) =>
      'item' in t ? t.item.index : -1
    )
    expect(taken).toEqual([0, 1, 2])

    expect(source.settle(1)).toBeUndefined()
    expect(source.settle(0)).toBe('k/b')
    expect(source.settle(2)).toBe('k/c')
  })

  it('reports a refused listing so the job can end with its reason', async () => {
    const s3 = fakeS3([], { failWith: httpError(403, 'AccessDenied', 'Access Denied') })
    const source = listingSource({ client: () => s3, bucket: 'b', prefix: 'src/', wake: () => {} })

    expect(source.take()).toEqual({ waiting: true })
    await settle()

    expect(source.take()).toEqual({ error: 'Access Denied' })
  })

  it('lets the sync of an empty folder finish', async () => {
    const s3 = fakeS3([{ key: 'other/x', size: 1 }])
    const finished = vi.fn()
    const queue = createTransferQueue({ onJobFinished: finished })
    const source = listingSource({
      client: () => s3,
      bucket: 'b',
      prefix: 'empty/',
      wake: () => queue.wake()
    })

    queue.add({
      id: 's',
      kind: 'sync',
      title: 's',
      target: { type: 'local', dir: '/' },
      createdAt: 0,
      source,
      run: async () => 'done' as const
    })
    await settle()

    expect(finished).toHaveBeenCalledWith('s')
  })
})
```

- [ ] **Step 4: Fehlschlag prüfen**

Run: `npx vitest run src/main/syncSource.test.ts`
Expected: FAIL — `Failed to resolve import "./syncSource"`; mit einem Stub (`export function listingSource() { return { take: () => ({ exhausted: true }) } as never }`) scheitern die Tests an Assertions.

- [ ] **Step 5: Sync-Quelle implementieren**

`src/main/syncSource.ts`:

```ts
import { ListObjectsV2Command } from '@aws-sdk/client-s3'
import type { ListClient } from './prefixScan'
import type { ItemSource, QueueItem, Take } from './transferQueue'

export interface SyncEntry {
  key: string
}

export interface ListingSource extends ItemSource<SyncEntry> {
  /** the whole prefix's size, once a parallel count has finished */
  setTotals(items: number, bytes: number): void
  /** record that an item settled; returns the new resume mark if it moved */
  settle(index: number): string | undefined
}

/**
 * Feeds a bucket sync to the queue one listing page at a time, so memory stays
 * flat however large the bucket is. The resume mark is the key up to which
 * every handed-out item has settled; a later run lists from there on.
 */
export function listingSource(opts: {
  client: () => ListClient
  bucket: string
  prefix: string
  /** continue after this key, from the mark of a previous run */
  startAfter?: string
  /** a page arrived: the queue should ask again */
  wake(): void
}): ListingSource {
  let buffer: QueueItem<SyncEntry>[] = []
  let token: string | undefined
  let firstPage = true
  let listedAll = false
  let fetching = false
  let stopped = false
  let failure: string | undefined
  let nextIndex = 0
  let totals: { items: number | null; bytes: number | null } = { items: null, bytes: null }
  const handedOut = new Map<number, string>()
  const settledAhead = new Set<number>()
  let contiguous = 0

  async function fetchPage(): Promise<void> {
    fetching = true
    try {
      const res = await opts.client().send(
        new ListObjectsV2Command({
          Bucket: opts.bucket,
          Prefix: opts.prefix || undefined,
          MaxKeys: 1000,
          ContinuationToken: token,
          StartAfter: firstPage ? opts.startAfter : undefined
        })
      )
      firstPage = false
      for (const o of res.Contents ?? []) {
        // "folder/" placeholders are not documents
        if (!o.Key || o.Key.endsWith('/')) continue
        buffer.push({
          index: nextIndex++,
          name: o.Key.slice(opts.prefix.length),
          size: o.Size ?? 0,
          data: { key: o.Key }
        })
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined
      listedAll = !token
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err)
    } finally {
      fetching = false
    }
    if (!stopped) opts.wake()
  }

  return {
    take(): Take<SyncEntry> {
      if (failure) return { error: failure }
      const item = buffer.shift()
      if (item) {
        handedOut.set(item.index, item.data.key)
        return { item }
      }
      if (listedAll || stopped) return { exhausted: true }
      if (!fetching) void fetchPage()
      return { waiting: true }
    },
    peek: (n) => buffer.slice(0, n),
    // unknown until the listing is complete; a failure must surface through take()
    waiting: () => (stopped ? 0 : failure || !listedAll ? null : buffer.length),
    totals: () => totals,
    drain() {
      stopped = true
      const left = buffer.length
      buffer = []
      return left
    },
    setTotals(items, bytes) {
      totals = { items, bytes }
    },
    settle(index) {
      settledAhead.add(index)
      let mark: string | undefined
      while (settledAhead.has(contiguous)) {
        mark = handedOut.get(contiguous)
        handedOut.delete(contiguous)
        settledAhead.delete(contiguous)
        contiguous++
      }
      return mark
    }
  }
}
```

- [ ] **Step 6: Tests laufen lassen**

Run: `npm test`
Expected: PASS — alle Tests aus `prefixScan`, `transferQueue` und `syncSource`. Danach `npm run typecheck` grün.

- [ ] **Step 7: Commit**

```bash
git add src/main/testing/fakeS3.ts src/main/prefixScan.test.ts src/main/syncSource.ts src/main/syncSource.test.ts
git commit -m "Add a paged item source for bucket syncs with a resume mark"
```

---

### Task 3: Builder und Runner für einzelne Items

**Files:**
- Create: `src/main/transferItems.ts`
- Modify: `src/main/transfers.ts` (entfernt die eigene `localPathFor`, importiert sie; wird in Task 5 gelöscht)
- Test: `src/main/transferItems.test.ts`

**Interfaces:**
- Consumes: `QueueItem`, `RunContext` (Task 1); `EntryRef` (Task 1, `@shared/types`); `fakeS3` (Task 2).
- Produces:
  - `interface UploadData { file: string; key: string }`, `interface DownloadData { key: string; rel: string }`, `interface CopyData { key: string; targetKey: string }`
  - `type ListKeys = (prefix: string) => Promise<{ key: string; size: number }[]>`
  - `interface GetClient { send(command: GetObjectCommand, options?: { abortSignal?: AbortSignal }): Promise<GetObjectCommandOutput> }`
  - `localPathFor(destDir: string, rel: string): string`
  - `buildUploadItems(prefix: string, paths: string[]): QueueItem<UploadData>[]`
  - `buildDownloadItems(list: ListKeys, entries: EntryRef[]): Promise<QueueItem<DownloadData>[]>`
  - `buildCopyItems(list: ListKeys, entries: EntryRef[], targetPrefix: string): Promise<QueueItem<CopyData>[]>`
  - `runUpload(client: S3Client, bucket: string, item: QueueItem<UploadData>, ctx: RunContext): Promise<'done'>`
  - `runDownload(client: GetClient, bucket: string, destDir: string, item: QueueItem<DownloadData>, ctx: RunContext): Promise<'done'>`
  - `interface CopyRoute { source: S3Client; target: S3Client; sameAccount: boolean; sourceBucket: string; targetBucket: string }`
  - `runCopy(route: CopyRoute, item: QueueItem<CopyData>, ctx: RunContext): Promise<'done'>`

- [ ] **Step 1: Tests schreiben**

`src/main/transferItems.test.ts`:

```ts
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { S3Client } from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'
import { fakeS3 } from './testing/fakeS3'
import {
  buildCopyItems,
  buildDownloadItems,
  buildUploadItems,
  localPathFor,
  runDownload,
  runUpload,
  type ListKeys
} from './transferItems'
import type { RunContext } from './transferQueue'

const ctx = (): RunContext => ({ signal: new AbortController().signal, onProgress: () => {} })
const tmp = (): string => mkdtempSync(join(tmpdir(), 's3b-'))
const listFrom =
  (objects: { key: string; size: number }[]): ListKeys =>
  async (prefix) =>
    objects.filter((o) => o.key.startsWith(prefix))

describe('localPathFor', () => {
  const root = resolve('/downloads/dest')

  it.each([
    ['photos/a.jpg', ['photos', 'a.jpg']],
    ['a/b/c.txt', ['a', 'b', 'c.txt']],
    ['weird name (1).txt', ['weird name (1).txt']],
    ['/etc/passwd', ['etc', 'passwd']]
  ])('keeps %j inside the chosen folder', (rel, parts) => {
    expect(localPathFor(root, rel)).toBe(join(root, ...parts))
  })

  it.each(['../../../.zshrc', 'docs/../../evil', '..', '.', 'a/./b', 'a\\..\\..\\evil.txt', 'a/\0b', ''])(
    'refuses %j',
    (rel) => {
      expect(() => localPathFor(root, rel)).toThrow()
    }
  )

  it.runIf(process.platform === 'win32')('refuses a drive prefix on Windows', () => {
    expect(() => localPathFor(root, 'C:evil.txt')).toThrow()
  })
})

describe('building items', () => {
  it('keeps the name of a copied folder, wherever it is copied to', async () => {
    const list = listFrom([{ key: 'src/ordner1/file2.png', size: 5 }])
    const folder = [{ key: 'src/ordner1/', type: 'folder' as const }]

    const intoRoot = await buildCopyItems(list, folder, '')
    const intoItself = await buildCopyItems(list, folder, 'ordner1/')

    expect(intoRoot.map((i) => i.data.targetKey)).toEqual(['ordner1/file2.png'])
    expect(intoItself.map((i) => i.data.targetKey)).toEqual(['ordner1/ordner1/file2.png'])
  })

  it('downloads a folder under its own name and leaves out placeholders', async () => {
    const list = listFrom([
      { key: 'a/photos/', size: 0 },
      { key: 'a/photos/x.jpg', size: 3 },
      { key: 'a/photos/2024/y.jpg', size: 4 }
    ])

    const items = await buildDownloadItems(list, [{ key: 'a/photos/', type: 'folder' }])

    expect(items.map((i) => [i.data.rel, i.size])).toEqual([
      ['photos/x.jpg', 3],
      ['photos/2024/y.jpg', 4]
    ])
  })

  it.skipIf(process.platform === 'win32')('does not follow symlinks out of an uploaded folder', () => {
    const dir = tmp()
    const outside = tmp()
    writeFileSync(join(outside, 'secret'), 'x')
    mkdirSync(join(dir, 'up'))
    writeFileSync(join(dir, 'up', 'a.txt'), 'hello')
    symlinkSync(outside, join(dir, 'up', 'link'))

    const items = buildUploadItems('pre/', [join(dir, 'up')])

    expect(items.map((i) => [i.data.key, i.size])).toEqual([['pre/up/a.txt', 5]])
  })
})

describe('running items', () => {
  it('fails an upload whose file disappeared, without contacting S3', async () => {
    const missing = join(tmp(), 'gone.txt')
    const noClient = {} as S3Client

    await expect(
      runUpload(noClient, 'b', { index: 0, name: 'gone.txt', size: 1, data: { file: missing, key: 'gone.txt' } }, ctx())
    ).rejects.toThrow('The file no longer exists')
  })

  it('refuses to download outside the chosen folder, without contacting S3', async () => {
    const s3 = fakeS3([{ key: '../evil', size: 1 }])

    await expect(
      runDownload(s3, 'b', tmp(), { index: 0, name: 'evil', size: 1, data: { key: '../evil', rel: '../evil' } }, ctx())
    ).rejects.toThrow(/Refusing/)
    expect(s3.requests).toHaveLength(0)
  })

  it('recreates a download folder that was deleted in the meantime', async () => {
    const s3 = fakeS3([{ key: 'k/a.txt', size: 5, body: 'hello' }])
    const dest = join(tmp(), 'gone', 'later')

    await runDownload(
      s3,
      'b',
      dest,
      { index: 0, name: 'a.txt', size: 5, data: { key: 'k/a.txt', rel: 'sub/a.txt' } },
      ctx()
    )

    expect(readFileSync(join(dest, 'sub', 'a.txt'), 'utf8')).toBe('hello')
  })
})
```

- [ ] **Step 2: Fehlschlag prüfen**

Run: `npx vitest run src/main/transferItems.test.ts`
Expected: FAIL — `Failed to resolve import "./transferItems"`.

- [ ] **Step 3: Modul implementieren**

`src/main/transferItems.ts`:

```ts
import { Upload } from '@aws-sdk/lib-storage'
import {
  CopyObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  type S3Client
} from '@aws-sdk/client-s3'
import {
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync
} from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Transform, type Readable } from 'node:stream'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { EntryRef } from '@shared/types'
import type { QueueItem, RunContext } from './transferQueue'

export interface UploadData {
  file: string
  key: string
}

export interface DownloadData {
  key: string
  /** path below the download folder; resolved through localPathFor on every run */
  rel: string
}

export interface CopyData {
  key: string
  targetKey: string
}

/** Lists every object under a prefix; injected so the builders need no S3. */
export type ListKeys = (prefix: string) => Promise<{ key: string; size: number }[]>

/** The slice of S3Client a download needs. */
export interface GetClient {
  send(
    command: GetObjectCommand,
    options?: { abortSignal?: AbortSignal }
  ): Promise<GetObjectCommandOutput>
}

/** CopyObject rejects sources above 5 GiB; larger objects fall back to streaming. */
const COPY_OBJECT_LIMIT = 5 * 1024 * 1024 * 1024

/**
 * Map an object key (relative to the download root) onto a path inside destDir.
 * Keys on shared buckets are attacker-controlled: ".."/"." segments, backslashes
 * and drive prefixes must never let a download escape the folder the user picked.
 */
export function localPathFor(destDir: string, rel: string): string {
  const segments = rel.split('/').filter((seg) => seg.length > 0)
  if (segments.length === 0) throw new Error(`Cannot derive a file name from "${rel}"`)
  for (const seg of segments) {
    const dotOnly = seg === '.' || seg === '..'
    const badChars = /[\\\0]/.test(seg) || (process.platform === 'win32' && seg.includes(':'))
    if (dotOnly || badChars) {
      throw new Error(`Refusing to write "${rel}": unsafe path segment "${seg}"`)
    }
  }
  const root = resolve(destDir)
  const target = resolve(root, ...segments)
  const inside = relative(root, target)
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`Refusing to write "${rel}" outside of ${root}`)
  }
  return target
}

/**
 * Expand local paths (files and directories) into files with their key suffix.
 * Symlinks inside a folder are skipped: following them could upload files from
 * outside the selected tree (e.g. a link to ~/.ssh) or loop forever on cycles.
 */
function expandLocal(paths: string[]): { file: string; rel: string; size: number }[] {
  const out: { file: string; rel: string; size: number }[] = []
  const walk = (abs: string, root: string): void => {
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) return
    if (st.isDirectory()) {
      for (const child of readdirSync(abs)) walk(join(abs, child), root)
    } else if (st.isFile()) {
      out.push({ file: abs, rel: relative(root, abs).split(sep).join('/'), size: st.size })
    }
  }
  for (const p of paths) {
    const st = statSync(p)
    if (st.isDirectory()) walk(p, dirname(p))
    else out.push({ file: p, rel: basename(p), size: st.size })
  }
  return out
}

/** Flatten a selection into objects; a selected folder keeps its own name. */
async function expandEntries(
  list: ListKeys,
  entries: EntryRef[]
): Promise<{ key: string; rel: string; size: number }[]> {
  const out: { key: string; rel: string; size: number }[] = []
  for (const e of entries) {
    if (e.type === 'folder') {
      const parentLen = e.key.replace(/\/$/, '').lastIndexOf('/') + 1
      for (const obj of await list(e.key)) {
        if (obj.key.endsWith('/')) continue
        out.push({ key: obj.key, rel: obj.key.slice(parentLen), size: obj.size })
      }
    } else {
      out.push({ key: e.key, rel: e.key.slice(e.key.lastIndexOf('/') + 1), size: e.size ?? 0 })
    }
  }
  return out
}

export function buildUploadItems(prefix: string, paths: string[]): QueueItem<UploadData>[] {
  return expandLocal(paths).map((e, index) => ({
    index,
    name: e.rel,
    size: e.size,
    data: { file: e.file, key: `${prefix}${e.rel}` }
  }))
}

export async function buildDownloadItems(
  list: ListKeys,
  entries: EntryRef[]
): Promise<QueueItem<DownloadData>[]> {
  return (await expandEntries(list, entries)).map((o, index) => ({
    index,
    name: o.rel,
    size: o.size,
    data: { key: o.key, rel: o.rel }
  }))
}

export async function buildCopyItems(
  list: ListKeys,
  entries: EntryRef[],
  targetPrefix: string
): Promise<QueueItem<CopyData>[]> {
  return (await expandEntries(list, entries)).map((o, index) => ({
    index,
    name: o.rel,
    size: o.size,
    data: { key: o.key, targetKey: `${targetPrefix}${o.rel}` }
  }))
}

/** lib-storage wants an AbortController of its own; follow the queue's signal. */
function controllerFor(signal: AbortSignal): AbortController {
  const controller = new AbortController()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', () => controller.abort(), { once: true })
  return controller
}

export async function runUpload(
  client: S3Client,
  bucket: string,
  item: QueueItem<UploadData>,
  ctx: RunContext
): Promise<'done'> {
  try {
    statSync(item.data.file)
  } catch {
    throw new Error('The file no longer exists')
  }
  const upload = new Upload({
    client,
    params: { Bucket: bucket, Key: item.data.key, Body: createReadStream(item.data.file) },
    queueSize: 4,
    partSize: 8 * 1024 * 1024,
    leavePartsOnError: false,
    abortController: controllerFor(ctx.signal)
  })
  upload.on('httpUploadProgress', (p) => ctx.onProgress(p.loaded ?? 0))
  await upload.done()
  return 'done'
}

export async function runDownload(
  client: GetClient,
  bucket: string,
  destDir: string,
  item: QueueItem<DownloadData>,
  ctx: RunContext
): Promise<'done'> {
  // recomputed on every run: a stored path is never trusted to stay inside destDir
  const target = localPathFor(destDir, item.data.rel)
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: item.data.key }), {
    abortSignal: ctx.signal
  })
  mkdirSync(dirname(target), { recursive: true })
  let loaded = 0
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      loaded += chunk.length
      ctx.onProgress(loaded)
      cb(null, chunk)
    }
  })
  await pipeline(res.Body as Readable, meter, createWriteStream(target), { signal: ctx.signal })
  return 'done'
}

export interface CopyRoute {
  source: S3Client
  target: S3Client
  sameAccount: boolean
  sourceBucket: string
  targetBucket: string
}

/** Copy one object: server-side within an account, streamed across accounts. */
export async function runCopy(
  route: CopyRoute,
  item: QueueItem<CopyData>,
  ctx: RunContext
): Promise<'done'> {
  const { key, targetKey } = item.data
  if (route.sameAccount && route.sourceBucket === route.targetBucket && key === targetKey) {
    throw new Error('Source and destination are the same object')
  }
  if (route.sameAccount && item.size <= COPY_OBJECT_LIMIT) {
    // server-side copy: the data never leaves the provider
    await route.source.send(
      new CopyObjectCommand({
        Bucket: route.targetBucket,
        CopySource: `${route.sourceBucket}/${key}`.split('/').map(encodeURIComponent).join('/'),
        Key: targetKey
      }),
      { abortSignal: ctx.signal }
    )
    ctx.onProgress(item.size)
    return 'done'
  }
  // across accounts: pipe the source stream straight into a multipart upload
  const res = await route.source.send(
    new GetObjectCommand({ Bucket: route.sourceBucket, Key: key }),
    { abortSignal: ctx.signal }
  )
  const total = res.ContentLength ?? item.size
  const upload = new Upload({
    client: route.target,
    params: {
      Bucket: route.targetBucket,
      Key: targetKey,
      Body: res.Body as Readable,
      ContentType: res.ContentType,
      Metadata: res.Metadata
    },
    queueSize: 4,
    // stay under the 10k part limit for very large objects
    partSize: Math.max(8 * 1024 * 1024, Math.ceil(total / 9000)),
    leavePartsOnError: false,
    abortController: controllerFor(ctx.signal)
  })
  upload.on('httpUploadProgress', (p) => ctx.onProgress(p.loaded ?? 0))
  await upload.done()
  return 'done'
}
```

- [ ] **Step 4: `transfers.ts` auf die gemeinsame `localPathFor` umstellen**

In `src/main/transfers.ts` die Funktion `localPathFor` samt ihrem Doc-Kommentar löschen und oben ergänzen:

```ts
import { localPathFor } from './transferItems'
```

Danach nicht mehr genutzte Importe aus `node:path` entfernen (`isAbsolute`, `resolve`), damit `noUnusedLocals` grün bleibt.

- [ ] **Step 5: Tests und Typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS — inklusive der neuen Tests aus `transferItems.test.ts` (auf Windows wird der Symlink-Test übersprungen und dafür der Laufwerks-Test ausgeführt).

- [ ] **Step 6: Mutationsprüfung**

- In `expandEntries` `parentLen` durch `e.key.length` ersetzen → „keeps the name of a copied folder…" scheitert.
- In `runDownload` die `localPathFor`-Zeile hinter den `send`-Aufruf verschieben → „…without contacting S3" scheitert.
- In `expandLocal` `if (st.isSymbolicLink()) return` entfernen → Symlink-Test scheitert.

- [ ] **Step 7: Commit**

```bash
git add src/main/transferItems.ts src/main/transferItems.test.ts src/main/transfers.ts
git commit -m "Split transfers into item builders and single-item runners"
```

---

### Task 4: Anfrage-Validierung, Queue-Service und Job-Fabrik

**Files:**
- Create: `src/main/jobRequest.ts`, Test: `src/main/jobRequest.test.ts`
- Create: `src/main/queueService.ts`, Test: `src/main/queueService.test.ts`
- Create: `src/main/jobFactory.ts`, Test: `src/main/jobFactory.test.ts`

**Interfaces:**
- Consumes: `createTransferQueue`, `arraySource`, `JobFailure`, `QueueItem`, `ItemSource`, `RunContext`, `Settled` (Task 1); `listingSource`, `SyncEntry` (Task 2); Builder/Runner und Typen aus `transferItems.ts` (Task 3); `countPrefix` aus `prefixScan.ts`.
- Produces:
  - `parseJobRequest(input: unknown): JobRequest` — wirft bei ungültiger Anfrage
  - `interface PlannedJob { kind: JobKind; title: string; target: JobTarget; items: QueueItem[] | null; conflicts: number[]; sample: string[]; spec: unknown }`
  - `interface JobRuntime { run(item: QueueItem, ctx: RunContext): Promise<'done' | 'skipped'>; source?: ItemSource; onSettled?(index: number): string | undefined }`
  - `interface RuntimeRequest { id: string; kind: JobKind; spec: unknown; conflict: ConflictMode; startAfter?: string }`
  - `interface JobFactory { plan(req: JobRequest): Promise<PlannedJob>; runtime(job: RuntimeRequest, wake: () => void): JobRuntime }`
  - `createQueueService(deps: { factory; emit(snapshot: QueueSnapshot): void; onJobDone(event: JobDoneEvent): void; newId(): string; now(): number; throttleMs?: number })` → `{ plan, enqueue, pauseAll, resumeAll, pauseJob, resumeJob, cancelJob, cancelItem, clearFinished, snapshot, revealDir }`
  - `createJobFactory(deps: { getClient(accountId): S3Client; accountExists(accountId): boolean; listKeys(accountId, bucket, prefix): Promise<{ key: string; size: number }[]> }): JobFactory`

- [ ] **Step 1: Tests für die Anfrage-Validierung**

`src/main/jobRequest.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseJobRequest } from './jobRequest'

const absFile = process.platform === 'win32' ? 'C:\\data\\a.txt' : '/data/a.txt'
const absDir = process.platform === 'win32' ? 'C:\\dl' : '/dl'

describe('parseJobRequest', () => {
  it('accepts a well-formed upload', () => {
    const req = { kind: 'upload', accountId: 'acc', bucket: 'b', prefix: 'p/', paths: [absFile] }

    expect(parseJobRequest(req)).toEqual(req)
  })

  it.each([
    ['an unknown kind', { kind: 'delete', accountId: 'a', bucket: 'b' }],
    ['a relative upload path', { kind: 'upload', accountId: 'a', bucket: 'b', prefix: '', paths: ['a.txt'] }],
    ['a relative download folder', { kind: 'download', accountId: 'a', bucket: 'b', entries: [], destDir: 'dl' }],
    [
      'an entry of unknown type',
      { kind: 'download', accountId: 'a', bucket: 'b', entries: [{ key: 'k', type: 'link' }], destDir: absDir }
    ],
    ['a copy without a target', { kind: 'copy', accountId: 'a', bucket: 'b', entries: [] }],
    ['something that is not an object', 'upload']
  ])('rejects %s', (_label, input) => {
    expect(() => parseJobRequest(input)).toThrow()
  })

  it('drops fields it does not know', () => {
    const parsed = parseJobRequest({
      kind: 'sync',
      accountId: 'a',
      bucket: 'b',
      prefix: '',
      target: { accountId: 'a', bucket: 'c', prefix: '', extra: 1 },
      evil: true
    })

    expect(parsed).toEqual({
      kind: 'sync',
      accountId: 'a',
      bucket: 'b',
      prefix: '',
      target: { accountId: 'a', bucket: 'c', prefix: '' }
    })
  })
})
```

Run: `npx vitest run src/main/jobRequest.test.ts` → Expected: FAIL (`Failed to resolve import "./jobRequest"`).

- [ ] **Step 2: Anfrage-Validierung implementieren**

`src/main/jobRequest.ts`:

```ts
import { isAbsolute } from 'node:path'
import type { EntryRef, JobRequest, S3Location } from '@shared/types'

function fail(what: string): never {
  throw new Error(`Invalid transfer request: ${what}`)
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(what)
  return value as Record<string, unknown>
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') fail(what)
  return value
}

function absolutePath(value: unknown, what: string): string {
  const path = text(value, what)
  if (!path || path.includes('\0') || !isAbsolute(path)) fail(what)
  return path
}

function location(value: unknown): S3Location {
  const o = record(value, 'target')
  return {
    accountId: text(o.accountId, 'target connection'),
    bucket: text(o.bucket, 'target bucket'),
    prefix: text(o.prefix, 'target folder')
  }
}

function entries(value: unknown): EntryRef[] {
  if (!Array.isArray(value)) fail('entries')
  return value.map((raw) => {
    const o = record(raw, 'entry')
    if (o.type !== 'file' && o.type !== 'folder') fail('entry type')
    const key = text(o.key, 'entry key')
    if (o.size === undefined) return { key, type: o.type }
    if (typeof o.size !== 'number' || !Number.isFinite(o.size) || o.size < 0) fail('entry size')
    return { key, type: o.type, size: o.size }
  })
}

/** Rebuild a renderer request field by field; nothing unexpected reaches the queue. */
export function parseJobRequest(input: unknown): JobRequest {
  const o = record(input, 'request')
  const accountId = text(o.accountId, 'connection')
  const bucket = text(o.bucket, 'bucket')
  switch (o.kind) {
    case 'upload':
      if (!Array.isArray(o.paths)) fail('paths')
      return {
        kind: 'upload',
        accountId,
        bucket,
        prefix: text(o.prefix, 'folder'),
        paths: o.paths.map((p) => absolutePath(p, 'upload path'))
      }
    case 'download':
      return {
        kind: 'download',
        accountId,
        bucket,
        entries: entries(o.entries),
        destDir: absolutePath(o.destDir, 'download folder')
      }
    case 'copy':
      return { kind: 'copy', accountId, bucket, entries: entries(o.entries), target: location(o.target) }
    case 'sync':
      return { kind: 'sync', accountId, bucket, prefix: text(o.prefix, 'folder'), target: location(o.target) }
    default:
      return fail('kind')
  }
}
```

Run: `npx vitest run src/main/jobRequest.test.ts` → Expected: PASS.

- [ ] **Step 3: Tests für den Queue-Service**

`src/main/queueService.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import type { JobRequest, QueueSnapshot } from '@shared/types'
import { createQueueService, type JobFactory, type PlannedJob } from './queueService'
import { arraySource, type QueueItem } from './transferQueue'

const settle = () => new Promise((r) => setTimeout(r, 5))
const request: JobRequest = { kind: 'upload', accountId: 'a', bucket: 'b', prefix: '', paths: [] }
const items = (n: number): QueueItem[] =>
  Array.from({ length: n }, (_, index) => ({ index, name: `f${index}`, size: 10, data: null }))

/** A factory that plans a fixed job of three items and records which ones ran. */
function fakeFactory(planned: Partial<PlannedJob> = {}) {
  const ran: number[] = []
  const factory: JobFactory = {
    plan: async () => ({
      kind: 'upload',
      title: 'Upload',
      target: { type: 's3', accountId: 'a', bucket: 'b', prefix: '' },
      items: items(3),
      conflicts: [],
      sample: [],
      spec: {},
      ...planned
    }),
    runtime: () => ({
      run: async (item) => {
        ran.push(item.index)
        return 'done'
      }
    })
  }
  return { factory, ran }
}

function service(factory: JobFactory, throttleMs = 0) {
  let id = 0
  const snapshots: QueueSnapshot[] = []
  const done = vi.fn()
  const svc = createQueueService({
    factory,
    emit: (s) => snapshots.push(s),
    onJobDone: done,
    newId: () => `id${++id}`,
    now: () => 1,
    throttleMs
  })
  return { svc, snapshots, done }
}

describe('queue service', () => {
  it('skips the conflicting items when asked to', async () => {
    const { factory, ran } = fakeFactory({ conflicts: [1] })
    const { svc } = service(factory)
    const plan = await svc.plan(request)
    expect(plan).toMatchObject({ total: 3, conflicts: 1 })

    svc.enqueue(plan.planId, 'skip')
    await settle()

    expect(ran).toEqual([0, 2])
    expect(svc.snapshot().jobs[0].items).toMatchObject({ total: 3, done: 2, skipped: 1 })
  })

  it('transfers every item when told to overwrite', async () => {
    const { factory, ran } = fakeFactory({ conflicts: [1] })
    const { svc } = service(factory)

    svc.enqueue((await svc.plan(request)).planId, 'overwrite')
    await settle()

    expect(ran).toEqual([0, 1, 2])
  })

  it('starts a plan only once', async () => {
    const { svc } = service(fakeFactory().factory)
    const plan = await svc.plan(request)
    svc.enqueue(plan.planId, 'overwrite')

    expect(() => svc.enqueue(plan.planId, 'overwrite')).toThrow()
  })

  it('forgets a plan once a newer one was made', async () => {
    const { svc } = service(fakeFactory().factory)
    const first = await svc.plan(request)
    const second = await svc.plan(request)

    expect(() => svc.enqueue(first.planId, 'overwrite')).toThrow()
    expect(() => svc.enqueue(second.planId, 'overwrite')).not.toThrow()
  })

  it('announces a finished job together with its target', async () => {
    const { svc, done } = service(fakeFactory().factory)

    const jobId = svc.enqueue((await svc.plan(request)).planId, 'overwrite')
    await settle()

    expect(done).toHaveBeenCalledWith({
      jobId,
      kind: 'upload',
      target: { type: 's3', accountId: 'a', bucket: 'b', prefix: '' }
    })
  })

  it('sends the final state of a job without waiting for the throttle', async () => {
    const { svc, snapshots } = service(fakeFactory().factory, 60_000)

    svc.enqueue((await svc.plan(request)).planId, 'overwrite')
    await settle()

    expect(snapshots.at(-1)?.jobs[0].finished).toBe(true)
  })

  it('lets a job that lists as it goes bring its own source', async () => {
    const seen: number[] = []
    const factory: JobFactory = {
      plan: async () => ({
        kind: 'sync',
        title: 'Sync',
        target: { type: 's3', accountId: 'a', bucket: 'c', prefix: '' },
        items: null,
        conflicts: [],
        sample: [],
        spec: {}
      }),
      runtime: () => ({
        source: arraySource(items(2)),
        onSettled: (index) => {
          seen.push(index)
          return undefined
        },
        run: async () => 'done'
      })
    }
    const { svc } = service(factory)
    const plan = await svc.plan({
      kind: 'sync',
      accountId: 'a',
      bucket: 'b',
      prefix: '',
      target: { accountId: 'a', bucket: 'c', prefix: '' }
    })
    expect(plan.total).toBeNull()

    svc.enqueue(plan.planId, 'skip')
    await settle()

    expect(seen.sort()).toEqual([0, 1])
  })

  it('knows the local folder of a download job and nothing for others', async () => {
    const { factory } = fakeFactory({ kind: 'download', target: { type: 'local', dir: '/dl' } })
    const { svc } = service(factory)

    const jobId = svc.enqueue((await svc.plan(request)).planId, 'overwrite')

    expect(svc.revealDir(jobId)).toBe('/dl')
    expect(svc.revealDir('unknown')).toBeUndefined()
  })
})
```

Run: `npx vitest run src/main/queueService.test.ts` → Expected: FAIL (`Failed to resolve import "./queueService"`).

- [ ] **Step 4: Queue-Service implementieren**

`src/main/queueService.ts`:

```ts
import type {
  ConflictMode,
  JobDoneEvent,
  JobKind,
  JobRequest,
  JobTarget,
  PlanSummary,
  QueueSnapshot
} from '@shared/types'
import {
  arraySource,
  createTransferQueue,
  type ItemSource,
  type QueueItem,
  type RunContext
} from './transferQueue'

export interface PlannedJob {
  kind: JobKind
  title: string
  target: JobTarget
  /** every item, known up front; null when the job lists its items as it goes (bucket sync) */
  items: QueueItem[] | null
  /** indices of items whose target already exists */
  conflicts: number[]
  /** a few conflicting target names for the dialog */
  sample: string[]
  /** what the factory needs to rebuild the job's runner, e.g. after a restart */
  spec: unknown
}

export interface JobRuntime {
  run(item: QueueItem, ctx: RunContext): Promise<'done' | 'skipped'>
  /** jobs that list their items as they go bring their own source */
  source?: ItemSource
  /** told about every settled item; returns a new resume mark when it moved */
  onSettled?(index: number): string | undefined
}

export interface RuntimeRequest {
  id: string
  kind: JobKind
  spec: unknown
  conflict: ConflictMode
  /** bucket sync: continue listing after this key */
  startAfter?: string
}

export interface JobFactory {
  plan(req: JobRequest): Promise<PlannedJob>
  runtime(job: RuntimeRequest, wake: () => void): JobRuntime
}

/** Ties the scheduler to the transfers it runs and to the renderer that watches it. */
export function createQueueService(deps: {
  factory: JobFactory
  emit(snapshot: QueueSnapshot): void
  onJobDone(event: JobDoneEvent): void
  newId(): string
  now(): number
  /** minimum gap between snapshots; the end of a job is never held back */
  throttleMs?: number
}) {
  const throttleMs = deps.throttleMs ?? 120
  const runtimes = new Map<string, JobRuntime>()
  const targets = new Map<string, { kind: JobKind; target: JobTarget }>()
  // only the newest plan can be started; an older one has lost its dialog
  let pending: { id: string; planned: PlannedJob } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const queue = createTransferQueue({
    onChange: scheduleEmit,
    onItemSettled: (jobId, item) => {
      runtimes.get(jobId)?.onSettled?.(item.index)
    },
    onJobFinished: (jobId) => {
      runtimes.delete(jobId)
      const info = targets.get(jobId)
      if (info) deps.onJobDone({ jobId, ...info })
      emitNow()
    }
  })

  function snapshot(): QueueSnapshot {
    return { paused: queue.isPaused(), jobs: queue.view(), restore: null }
  }

  function emitNow(): void {
    if (timer) clearTimeout(timer)
    timer = undefined
    deps.emit(snapshot())
  }

  function scheduleEmit(): void {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      deps.emit(snapshot())
    }, throttleMs)
  }

  const wake = (): void => {
    queue.wake()
    scheduleEmit()
  }

  return {
    async plan(req: JobRequest): Promise<PlanSummary> {
      const planned = await deps.factory.plan(req)
      pending = { id: deps.newId(), planned }
      return {
        planId: pending.id,
        total: planned.items ? planned.items.length : null,
        conflicts: planned.conflicts.length,
        sample: planned.sample
      }
    },

    enqueue(planId: string, mode: ConflictMode): string {
      if (!pending || pending.id !== planId) {
        throw new Error('This transfer was already started or has expired — please start it again')
      }
      const { planned } = pending
      pending = undefined
      const id = deps.newId()
      const runtime = deps.factory.runtime(
        { id, kind: planned.kind, spec: planned.spec, conflict: mode },
        wake
      )
      runtimes.set(id, runtime)
      targets.set(id, { kind: planned.kind, target: planned.target })

      const skip = new Set(mode === 'skip' ? planned.conflicts : [])
      const all = planned.items ?? []
      const skipped = all.filter((i) => skip.has(i.index))
      const skippedBytes = skipped.reduce((sum, i) => sum + i.size, 0)
      queue.add({
        id,
        kind: planned.kind,
        title: planned.title,
        target: planned.target,
        createdAt: deps.now(),
        source:
          runtime.source ??
          arraySource(
            all.filter((i) => !skip.has(i.index)),
            { items: skipped.length, bytes: skippedBytes }
          ),
        run: runtime.run,
        settled: { done: 0, skipped: skipped.length, cancelled: 0, bytes: skippedBytes, failed: [] }
      })
      return id
    },

    pauseAll: (): void => queue.pauseAll(),
    resumeAll: (): void => queue.resumeAll(),
    pauseJob: (id: string): void => queue.pauseJob(id),
    resumeJob: (id: string): void => queue.resumeJob(id),
    cancelJob: (id: string): void => queue.cancelJob(id),
    cancelItem: (id: string, index: number): void => queue.cancelItem(id, index),

    clearFinished(): void {
      queue.clearFinished()
      for (const id of [...targets.keys()]) if (!queue.has(id)) targets.delete(id)
    },

    snapshot,

    /** the local folder a download job writes to, for "Show in folder" */
    revealDir(id: string): string | undefined {
      const target = targets.get(id)?.target
      return target?.type === 'local' ? target.dir : undefined
    }
  }
}
```

Run: `npx vitest run src/main/queueService.test.ts` → Expected: PASS (8 Tests).

- [ ] **Step 5: Tests für die Job-Fabrik**

Die Fabrik ist überwiegend Verdrahtung; ihre Übertragungen prüft der Ende-zu-Ende-Lauf in Task 5. Hier getestet werden die Entscheidungen, die sie selbst trifft.

`src/main/jobFactory.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { S3Client } from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'
import { createJobFactory } from './jobFactory'
import { JobFailure } from './transferQueue'

const factory = (accountExists = true) =>
  createJobFactory({
    getClient: () => ({}) as S3Client,
    accountExists: () => accountExists,
    listKeys: async () => []
  })

describe('job factory', () => {
  it('plans an upload of the picked files into the open folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's3b-'))
    writeFileSync(join(dir, 'a.txt'), 'aa')
    writeFileSync(join(dir, 'b.txt'), 'bbb')

    const planned = await factory().plan({
      kind: 'upload',
      accountId: 'acc',
      bucket: 'b',
      prefix: 'p/',
      paths: [join(dir, 'a.txt'), join(dir, 'b.txt')]
    })

    expect(planned.title).toBe('Upload 2 files → b/p/')
    expect(planned.target).toEqual({ type: 's3', accountId: 'acc', bucket: 'b', prefix: 'p/' })
    expect(planned.items?.map((i) => [i.name, i.size])).toEqual([
      ['a.txt', 2],
      ['b.txt', 3]
    ])
  })

  it('refuses to sync a folder onto itself', async () => {
    await expect(
      factory().plan({
        kind: 'sync',
        accountId: 'a',
        bucket: 'b',
        prefix: 'x/',
        target: { accountId: 'a', bucket: 'b', prefix: 'x/' }
      })
    ).rejects.toThrow('Source and destination are identical')
  })

  it('fails a job whose connection was deleted as a whole', async () => {
    const runtime = factory(false).runtime(
      { id: 'j', kind: 'upload', spec: { accountId: 'gone', bucket: 'b' }, conflict: 'overwrite' },
      () => {}
    )

    await expect(
      runtime.run(
        { index: 0, name: 'a', size: 1, data: { file: '/x', key: 'a' } },
        { signal: new AbortController().signal, onProgress: () => {} }
      )
    ).rejects.toBeInstanceOf(JobFailure)
  })
})
```

Run: `npx vitest run src/main/jobFactory.test.ts` → Expected: FAIL (`Failed to resolve import "./jobFactory"`).

- [ ] **Step 6: Job-Fabrik implementieren**

`src/main/jobFactory.ts`:

```ts
import { basename } from 'node:path'
import type { S3Client } from '@aws-sdk/client-s3'
import type { ConflictMode, S3Location } from '@shared/types'
import { countPrefix } from './prefixScan'
import type { JobFactory, JobRuntime, PlannedJob } from './queueService'
import { listingSource, type SyncEntry } from './syncSource'
import {
  buildCopyItems,
  buildDownloadItems,
  buildUploadItems,
  runCopy,
  runDownload,
  runUpload,
  type CopyData,
  type CopyRoute,
  type DownloadData,
  type ListKeys,
  type UploadData
} from './transferItems'
import { JobFailure, type QueueItem } from './transferQueue'

interface UploadSpec {
  accountId: string
  bucket: string
}

interface DownloadSpec {
  accountId: string
  bucket: string
  destDir: string
}

interface CopySpec {
  accountId: string
  bucket: string
  target: S3Location
}

interface SyncSpec {
  accountId: string
  bucket: string
  prefix: string
  target: S3Location
}

const count = (n: number, word: string): string => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`
const at = (bucket: string, prefix: string): string => `${bucket}/${prefix}`

export interface FactoryDeps {
  getClient(accountId: string): S3Client
  accountExists(accountId: string): boolean
  listKeys(accountId: string, bucket: string, prefix: string): Promise<{ key: string; size: number }[]>
}

export function createJobFactory(deps: FactoryDeps): JobFactory {
  const lister =
    (accountId: string, bucket: string): ListKeys =>
    (prefix) =>
      deps.listKeys(accountId, bucket, prefix)

  /** Checked per item, so a deleted connection ends the job once instead of failing every item. */
  function client(accountId: string): S3Client {
    if (!deps.accountExists(accountId)) {
      throw new JobFailure('The connection used by this job no longer exists')
    }
    return deps.getClient(accountId)
  }

  function route(accountId: string, bucket: string, target: S3Location): CopyRoute {
    return {
      source: client(accountId),
      target: client(target.accountId),
      sameAccount: accountId === target.accountId,
      sourceBucket: bucket,
      targetBucket: target.bucket
    }
  }

  function syncRuntime(
    spec: SyncSpec,
    conflict: ConflictMode,
    startAfter: string | undefined,
    wake: () => void
  ): JobRuntime {
    const source = listingSource({
      client: () => client(spec.accountId),
      bucket: spec.bucket,
      prefix: spec.prefix,
      startAfter,
      wake
    })
    // the whole prefix is counted alongside; until then the job shows no total
    void (async () => {
      try {
        const totals = await countPrefix(client(spec.accountId), spec.bucket, spec.prefix)
        source.setTotals(totals.objects, totals.bytes)
        wake()
      } catch {
        // the sync still runs, only without a total
      }
    })()
    // one listing of the destination answers "already there with this size?" for every object
    let existing: Promise<Map<string, number>> | undefined
    const existingSizes = (): Promise<Map<string, number>> =>
      (existing ??= deps
        .listKeys(spec.target.accountId, spec.target.bucket, spec.target.prefix)
        .then((list) => new Map(list.map((o) => [o.key, o.size]))))

    return {
      source,
      onSettled: (index) => source.settle(index),
      async run(item, ctx) {
        const entry = item as QueueItem<SyncEntry>
        const targetKey = spec.target.prefix + entry.data.key.slice(spec.prefix.length)
        const sameObject =
          spec.accountId === spec.target.accountId &&
          spec.bucket === spec.target.bucket &&
          entry.data.key === targetKey
        if (sameObject) return 'skipped'
        if (conflict === 'skip' && (await existingSizes()).get(targetKey) === entry.size) {
          return 'skipped'
        }
        return runCopy(
          route(spec.accountId, spec.bucket, spec.target),
          { ...entry, data: { key: entry.data.key, targetKey } },
          ctx
        )
      }
    }
  }

  return {
    async plan(req): Promise<PlannedJob> {
      switch (req.kind) {
        case 'upload': {
          const items = buildUploadItems(req.prefix, req.paths)
          const spec: UploadSpec = { accountId: req.accountId, bucket: req.bucket }
          return {
            kind: 'upload',
            title: `Upload ${count(items.length, 'file')} → ${at(req.bucket, req.prefix)}`,
            target: { type: 's3', accountId: req.accountId, bucket: req.bucket, prefix: req.prefix },
            items,
            conflicts: [],
            sample: [],
            spec
          }
        }
        case 'download': {
          const items = await buildDownloadItems(lister(req.accountId, req.bucket), req.entries)
          const spec: DownloadSpec = { accountId: req.accountId, bucket: req.bucket, destDir: req.destDir }
          return {
            kind: 'download',
            title: `Download ${count(items.length, 'file')} → ${basename(req.destDir)}`,
            target: { type: 'local', dir: req.destDir },
            items,
            conflicts: [],
            sample: [],
            spec
          }
        }
        case 'copy': {
          const items = await buildCopyItems(lister(req.accountId, req.bucket), req.entries, req.target.prefix)
          // today's check, narrowed to what a selection touches in Task 9
          const existing = new Set(
            (await deps.listKeys(req.target.accountId, req.target.bucket, req.target.prefix)).map((o) => o.key)
          )
          const clashing = items.filter((i) => existing.has(i.data.targetKey))
          const spec: CopySpec = { accountId: req.accountId, bucket: req.bucket, target: req.target }
          return {
            kind: 'copy',
            title: `Copy ${count(items.length, 'object')} → ${at(req.target.bucket, req.target.prefix)}`,
            target: { type: 's3', ...req.target },
            items,
            conflicts: clashing.map((i) => i.index),
            sample: clashing.slice(0, 5).map((i) => i.data.targetKey),
            spec
          }
        }
        case 'sync': {
          const onto =
            req.accountId === req.target.accountId &&
            req.bucket === req.target.bucket &&
            req.prefix === req.target.prefix
          if (onto) throw new Error('Source and destination are identical')
          const spec: SyncSpec = { accountId: req.accountId, bucket: req.bucket, prefix: req.prefix, target: req.target }
          return {
            kind: 'sync',
            title: `Copy contents ${at(req.bucket, req.prefix)} → ${at(req.target.bucket, req.target.prefix)}`,
            target: { type: 's3', ...req.target },
            items: null,
            conflicts: [],
            sample: [],
            spec
          }
        }
      }
    },

    runtime(job, wake): JobRuntime {
      switch (job.kind) {
        case 'upload': {
          const s = job.spec as UploadSpec
          return {
            run: async (item, ctx) => runUpload(client(s.accountId), s.bucket, item as QueueItem<UploadData>, ctx)
          }
        }
        case 'download': {
          const s = job.spec as DownloadSpec
          return {
            run: async (item, ctx) =>
              runDownload(client(s.accountId), s.bucket, s.destDir, item as QueueItem<DownloadData>, ctx)
          }
        }
        case 'copy': {
          const s = job.spec as CopySpec
          return {
            run: async (item, ctx) =>
              runCopy(route(s.accountId, s.bucket, s.target), item as QueueItem<CopyData>, ctx)
          }
        }
        case 'sync':
          return syncRuntime(job.spec as SyncSpec, job.conflict, job.startAfter, wake)
      }
    }
  }
}
```

- [ ] **Step 7: Tests und Typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS für alle Testdateien; Typecheck grün.

- [ ] **Step 8: Commit**

```bash
git add src/main/jobRequest.ts src/main/jobRequest.test.ts src/main/queueService.ts src/main/queueService.test.ts src/main/jobFactory.ts src/main/jobFactory.test.ts
git commit -m "Add the queue service, job factory and request validation"
```

---

### Task 5: Kanäle, Preload und Oberfläche umstellen

**Files:**
- Modify: `src/main/ipc.ts`, `src/preload/index.ts`, `src/shared/types.ts`
- Delete: `src/main/transfers.ts`
- Modify: `src/renderer/src/components/Icons.tsx`, `src/renderer/src/components/ConflictDialog.tsx`, `src/renderer/src/App.tsx`, `src/renderer/src/styles.css`
- Rewrite: `src/renderer/src/components/TransferPanel.tsx`
- Verification (nicht committet): `<scratchpad>/e2e/fake-s3.cjs`, `<scratchpad>/e2e/queue.cjs`

**Interfaces:**
- Consumes: `createQueueService`, `createJobFactory`, `parseJobRequest` (Task 4); Typen aus Task 1.
- Produces (Renderer-API `window.api.queue`): `plan(req: JobRequest): Promise<PlanSummary>`, `enqueue(planId, mode: ConflictMode): Promise<string>`, `list(): Promise<QueueSnapshot>`, `pauseAll()`, `resumeAll()`, `pauseJob(id)`, `resumeJob(id)`, `cancelJob(id)`, `cancelItem(id, index)`, `clearFinished()`, `revealJob(id)`, `onUpdate(cb: (s: QueueSnapshot) => void): () => void`, `onJobDone(cb: (e: JobDoneEvent) => void): () => void`. Kanäle `queue:update`, `queue:jobDone`.

- [ ] **Step 1: `ipc.ts` umstellen**

In `src/main/ipc.ts`:

1. Importe: `import { isAbsolute } from 'node:path'` und `import * as transfers from './transfers'` entfernen; ergänzen:

```ts
import { randomUUID } from 'node:crypto'
import { createJobFactory } from './jobFactory'
import { parseJobRequest } from './jobRequest'
import { createQueueService } from './queueService'
```

und den Typ-Import zu `import type { AccountInput, ConflictMode, Result } from '@shared/types'` erweitern.

2. Die Funktion `assertAbsolutePath` ersetzen durch:

```ts
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** Job and plan ids are UUIDs; they also name files under userData/queue. */
function jobId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(value)) throw new Error('Invalid job id')
  return value
}

function conflictMode(value: unknown): ConflictMode {
  if (value !== 'skip' && value !== 'overwrite') throw new Error('Invalid conflict choice')
  return value
}
```

3. Den Anfang von `registerIpc` bis vor `// ---- accounts ----` ersetzen durch:

```ts
export function registerIpc(): void {
  const scanner = createPrefixScanner({
    getClient: (accountId) => s3.getClient(accountId),
    emit: (stats) => broadcast('prefix:stats', stats)
  })
  const queue = createQueueService({
    factory: createJobFactory({
      getClient: (accountId) => s3.getClient(accountId),
      accountExists: (accountId) => store.getAccount(accountId) !== undefined,
      listKeys: (accountId, bucket, prefix) => s3.listAllKeys(accountId, bucket, prefix)
    }),
    emit: (snapshot) => broadcast('queue:update', snapshot),
    onJobDone: (event) => broadcast('queue:jobDone', event),
    newId: () => randomUUID(),
    now: () => Date.now()
  })
```

4. Den ganzen Abschnitt von `// ---- transfers ----` bis einschließlich `wrap('transfer:clear', () => transfers.clearFinishedTransfers())` ersetzen durch:

```ts
  // ---- transfer queue -------------------------------------------------
  wrap('queue:plan', (req: unknown) => queue.plan(parseJobRequest(req)))
  wrap('queue:enqueue', (planId: unknown, mode: unknown) =>
    queue.enqueue(jobId(planId), conflictMode(mode))
  )
  wrap('queue:list', () => queue.snapshot())
  wrap('queue:pauseAll', () => queue.pauseAll())
  wrap('queue:resumeAll', () => queue.resumeAll())
  wrap('queue:pauseJob', (id: unknown) => queue.pauseJob(jobId(id)))
  wrap('queue:resumeJob', (id: unknown) => queue.resumeJob(jobId(id)))
  wrap('queue:cancelJob', (id: unknown) => queue.cancelJob(jobId(id)))
  wrap('queue:cancelItem', (id: unknown, index: unknown) => {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) throw new Error('Invalid item')
    queue.cancelItem(jobId(id), index)
  })
  wrap('queue:clearFinished', () => queue.clearFinished())
  // the folder comes from the job itself, never from the renderer
  wrap('queue:revealJob', async (id: unknown) => {
    const dir = queue.revealDir(jobId(id))
    if (!dir) throw new Error('This job has no local folder')
    const failure = await shell.openPath(dir)
    if (failure) throw new Error(failure)
  })
```

5. Den Handler `shell:showItem` (samt Kommentar darüber) löschen.

- [ ] **Step 2: Preload umstellen**

In `src/preload/index.ts`:
1. Im Typ-Import `Transfer` durch `ConflictMode, JobDoneEvent, JobRequest, PlanSummary, QueueSnapshot` ersetzen.
2. Den Block `transfers: { … },` (bis vor `dialog: {`) ersetzen durch:

```ts
  queue: {
    /** expand a transfer and check its targets; nothing runs until enqueue */
    plan: (req: JobRequest) => call<PlanSummary>('queue:plan', req),
    enqueue: (planId: string, mode: ConflictMode) => call<string>('queue:enqueue', planId, mode),
    list: () => call<QueueSnapshot>('queue:list'),
    pauseAll: () => call<void>('queue:pauseAll'),
    resumeAll: () => call<void>('queue:resumeAll'),
    pauseJob: (id: string) => call<void>('queue:pauseJob', id),
    resumeJob: (id: string) => call<void>('queue:resumeJob', id),
    cancelJob: (id: string) => call<void>('queue:cancelJob', id),
    cancelItem: (id: string, index: number) => call<void>('queue:cancelItem', id, index),
    clearFinished: () => call<void>('queue:clearFinished'),
    revealJob: (id: string) => call<void>('queue:revealJob', id),
    onUpdate: (cb: (s: QueueSnapshot) => void): (() => void) => {
      const listener = (_e: unknown, s: QueueSnapshot): void => cb(s)
      ipcRenderer.on('queue:update', listener)
      return () => {
        ipcRenderer.removeListener('queue:update', listener)
      }
    },
    onJobDone: (cb: (e: JobDoneEvent) => void): (() => void) => {
      const listener = (_e: unknown, e: JobDoneEvent): void => cb(e)
      ipcRenderer.on('queue:jobDone', listener)
      return () => {
        ipcRenderer.removeListener('queue:jobDone', listener)
      }
    }
  },
```

3. Im Block `system` die Zeile `showItem: …` löschen.

- [ ] **Step 3: Altes Modul und alte Typen entfernen**

```bash
git rm src/main/transfers.ts
```

In `src/shared/types.ts` die Deklarationen `export type TransferKind = …`, `export type TransferStatus = …` und `export interface Transfer { … }` löschen.

- [ ] **Step 4: Icons ergänzen**

Am Ende von `src/renderer/src/components/Icons.tsx`:

```tsx
export const PauseIcon = ({ size = 13, className }: Props) => (
  <svg {...base(size)} className={`icon ${className ?? ''}`}>
    <path d="M5.5 3.5v9M10.5 3.5v9" />
  </svg>
)

export const PlayIcon = ({ size = 13, className }: Props) => (
  <svg {...base(size)} className={`icon ${className ?? ''}`}>
    <path d="M5 3.5l7 4.5-7 4.5Z" />
  </svg>
)
```

- [ ] **Step 5: Konflikt-Dialog verallgemeinern**

In `src/renderer/src/components/ConflictDialog.tsx`:
1. Im `Props`-Interface und in der Destrukturierung `targetBucket` → `targetLabel`.
2. `in “{targetBucket}”:` → `in “{targetLabel}”:`
3. Den Hinweistext ersetzen durch:

```tsx
          <div className="hint">
            “Skip existing” transfers only the {total - conflicts} object
            {total - conflicts === 1 ? '' : 's'} that {total - conflicts === 1 ? 'is' : 'are'} not
            at the destination yet. “Overwrite” replaces the existing ones.
          </div>
```

- [ ] **Step 6: Transfer-Panel neu schreiben**

`src/renderer/src/components/TransferPanel.tsx` vollständig ersetzen:

```tsx
import { useRef, useState } from 'react'
import type { QueueSnapshot, TransferItemView, TransferJobView } from '@shared/types'
import { formatBytes } from '@shared/format'
import {
  ChevronIcon,
  CopyIcon,
  DownloadIcon,
  FolderIcon,
  PauseIcon,
  PlayIcon,
  UploadIcon,
  XIcon
} from './Icons'

interface Props {
  queue: QueueSnapshot
  onPauseAll(): void
  onResumeAll(): void
  onPauseJob(id: string): void
  onResumeJob(id: string): void
  onCancelJob(id: string): void
  onCancelItem(id: string, index: number): void
  onClear(): void
  onReveal(id: string): void
}

interface SpeedSample {
  done: number
  time: number
  speed: number
}

const KIND_ICON = { upload: UploadIcon, download: DownloadIcon, copy: CopyIcon, sync: CopyIcon }

function percent(job: TransferJobView): number {
  if (job.bytes.total) return Math.min(100, (job.bytes.done / job.bytes.total) * 100)
  const { items } = job
  const settled = items.done + items.skipped + items.failed + items.cancelled
  return items.total ? Math.min(100, (settled / items.total) * 100) : 0
}

/** One line under the title: how far the job is and what it is doing right now. */
function summary(job: TransferJobView, speed: number): string {
  if (job.error) return `Failed — ${job.error}`
  const { items } = job
  const settled = (items.done + items.skipped).toLocaleString()
  const parts = [items.total === null ? `${settled} objects` : `${settled} / ${items.total.toLocaleString()}`]
  if (items.skipped) parts.push(`${items.skipped.toLocaleString()} skipped`)
  if (items.failed) parts.push(`${items.failed.toLocaleString()} failed`)
  if (items.cancelled) parts.push(`${items.cancelled.toLocaleString()} cancelled`)
  if (!job.finished) {
    if (job.paused) parts.push(items.running ? `paused — ${items.running} finishing` : 'paused')
    else if (speed > 0) parts.push(`${formatBytes(speed)}/s`)
  }
  return parts.join(' · ')
}

function jobStatus(job: TransferJobView): string {
  if (job.error || (job.finished && job.items.failed)) return 'error'
  if (job.finished) return job.items.done || job.items.skipped ? 'done' : 'cancelled'
  return 'running'
}

function ItemRow({ item, onCancel }: { item: TransferItemView; onCancel?: () => void }) {
  const pct = item.size > 0 ? Math.min(100, (item.loaded / item.size) * 100) : 0
  const failed = item.status === 'error'
  return (
    <div className="transfer-row item-row">
      <span />
      <div className="tmain" title={item.error ?? item.name}>
        <span className="tname">{item.name}</span>
        {item.error && <span className="tsub error">{item.error}</span>}
      </div>
      <div className={`progress ${item.status}`}>
        <div style={{ width: `${failed ? 100 : pct}%` }} />
      </div>
      <span className={`tstatus ${failed ? 'error' : ''}`}>{failed ? 'failed' : `${Math.round(pct)}%`}</span>
      {onCancel ? (
        <button className="ghost" style={{ padding: 2 }} title="Cancel" onClick={onCancel}>
          <XIcon size={12} />
        </button>
      ) : (
        <span />
      )}
    </div>
  )
}

function JobRow(props: {
  job: TransferJobView
  speed: number
  expanded: boolean
  onToggle(): void
} & Omit<Props, 'queue' | 'onPauseAll' | 'onResumeAll' | 'onClear'>) {
  const { job, speed, expanded } = props
  const Icon = KIND_ICON[job.kind]
  const single = job.items.total === 1
  const waiting = job.items.waiting ?? 0
  return (
    <div className="job">
      <div className="transfer-row job-row">
        <span
          className="job-toggle"
          onClick={single ? undefined : props.onToggle}
          style={{
            cursor: single ? 'default' : 'pointer',
            transform: expanded && !single ? 'rotate(90deg)' : 'none'
          }}
        >
          {single ? <Icon size={13} /> : <ChevronIcon size={11} />}
        </span>
        <div className="tmain" title={job.title}>
          <span className="tname">
            {!single && <Icon size={12} />} {job.title}
          </span>
          <span className="tsub">{summary(job, speed)}</span>
        </div>
        <div className={`progress ${jobStatus(job)}`}>
          <div style={{ width: `${percent(job)}%` }} />
        </div>
        <span className="tstatus">{formatBytes(job.bytes.total ?? job.bytes.done)}</span>
        <span className="job-actions">
          {job.target.type === 'local' && job.items.done > 0 && (
            <button className="ghost" title="Show in folder" onClick={() => props.onReveal(job.id)}>
              <FolderIcon size={12} />
            </button>
          )}
          {!job.finished &&
            (job.paused ? (
              <button className="ghost" title="Resume" onClick={() => props.onResumeJob(job.id)}>
                <PlayIcon size={12} />
              </button>
            ) : (
              <button className="ghost" title="Pause" onClick={() => props.onPauseJob(job.id)}>
                <PauseIcon size={12} />
              </button>
            ))}
          {!job.finished && (
            <button className="ghost" title="Cancel" onClick={() => props.onCancelJob(job.id)}>
              <XIcon size={12} />
            </button>
          )}
        </span>
      </div>
      {expanded && !single && (
        <div className="job-items">
          {job.running.map((item) => (
            <ItemRow key={`r${item.index}`} item={item} onCancel={() => props.onCancelItem(job.id, item.index)} />
          ))}
          {job.failed.map((item) => (
            <ItemRow key={`f${item.index}`} item={item} />
          ))}
          {job.upcoming.length > 0 && (
            <div className="job-upcoming">
              · {job.upcoming[0].name}
              {job.upcoming.length > 1 && ` … ${job.upcoming[job.upcoming.length - 1].name}`}
              {waiting > job.upcoming.length && (
                <span className="more"> + {(waiting - job.upcoming.length).toLocaleString()} more waiting</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function TransferPanel(props: Props) {
  const { queue } = props
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const samples = useRef(new Map<string, SpeedSample>())

  /** smoothed bytes/second from the byte deltas between renders */
  function speedOf(job: TransferJobView): number {
    if (job.finished || job.paused || job.items.running === 0) {
      samples.current.delete(job.id)
      return 0
    }
    const now = Date.now()
    const prev = samples.current.get(job.id)
    if (!prev) {
      samples.current.set(job.id, { done: job.bytes.done, time: now, speed: 0 })
      return 0
    }
    const dt = now - prev.time
    if (dt < 500) return prev.speed
    const instant = ((job.bytes.done - prev.done) * 1000) / dt
    const speed = prev.speed > 0 ? prev.speed * 0.7 + instant * 0.3 : instant
    samples.current.set(job.id, { done: job.bytes.done, time: now, speed })
    return speed
  }

  if (queue.jobs.length === 0) return null

  const running = queue.jobs.reduce((n, j) => n + j.items.running, 0)
  const waiting = queue.jobs.reduce((n, j) => n + (j.finished ? 0 : (j.items.waiting ?? 0)), 0)
  const failed = queue.jobs.reduce((n, j) => n + j.items.failed, 0)
  const anyActive = queue.jobs.some((j) => !j.finished)

  return (
    <div className="transfers">
      <div className="transfers-head" onClick={() => setOpen((v) => !v)}>
        <span style={{ display: 'flex', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}>
          <ChevronIcon size={12} />
        </span>
        <strong style={{ color: 'var(--text)' }}>Transfers</strong>
        {running > 0 && <span className="badge">{running} active</span>}
        {waiting > 0 && <span className="badge">{waiting.toLocaleString()} waiting</span>}
        {failed > 0 && (
          <span className="badge" style={{ color: 'var(--danger)' }}>
            {failed} failed
          </span>
        )}
        {queue.paused && <span className="badge">{running > 0 ? `paused — ${running} finishing` : 'paused'}</span>}
        <span className="spacer" />
        {anyActive && (
          <button
            className="ghost"
            style={{ fontSize: 11.5, padding: '2px 7px' }}
            onClick={(e) => {
              e.stopPropagation()
              if (queue.paused) props.onResumeAll()
              else props.onPauseAll()
            }}
          >
            {queue.paused ? <PlayIcon size={11} /> : <PauseIcon size={11} />}
            {queue.paused ? ' Resume all' : ' Pause all'}
          </button>
        )}
        <button
          className="ghost"
          style={{ fontSize: 11.5, padding: '2px 7px' }}
          onClick={(e) => {
            e.stopPropagation()
            props.onClear()
          }}
        >
          Clear finished
        </button>
      </div>

      {open && (
        <div className="transfers-list">
          {queue.jobs.map((job) => (
            <JobRow
              key={job.id}
              {...props}
              job={job}
              speed={speedOf(job)}
              expanded={expanded[job.id] ?? !job.finished}
              onToggle={() => setExpanded((s) => ({ ...s, [job.id]: !(s[job.id] ?? !job.finished) }))}
            />
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 7: Styles ergänzen**

In `src/renderer/src/styles.css` direkt nach der Regel `.tstatus.error { … }` einfügen:

```css
.job-row { grid-template-columns: 16px 1fr 130px 74px 64px; }
.job-toggle {
  display: flex;
  align-items: center;
  color: var(--text-faint);
  transition: transform .12s;
}
.job-actions { display: flex; justify-content: flex-end; gap: 2px; }
.job-actions button { padding: 2px; }
.job-items { padding-left: 26px; }
.item-row { padding: 3px 0; }
.transfer-row .tsub.error { color: var(--danger); }
.transfer-row .tname svg { vertical-align: -2px; }
.job-upcoming {
  font-size: 11px;
  color: var(--text-faint);
  padding: 3px 0 5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.job-upcoming .more { color: var(--text-dim); }
```

- [ ] **Step 8: `App.tsx` umstellen**

In `src/renderer/src/App.tsx`:

1. Typ-Import ersetzen durch:

```ts
import type {
  Account,
  BucketInfo,
  ConflictMode,
  JobRequest,
  PlanSummary,
  PrefixStats,
  QueueSnapshot,
  S3Entry
} from '@shared/types'
```

2. `const [transfers, setTransfers] = useState<Transfer[]>([])` ersetzen durch:

```ts
  const [queue, setQueue] = useState<QueueSnapshot>({ paused: false, jobs: [], restore: null })
```

3. Den ganzen `useState`-Block von `conflictPrompt` ersetzen durch:

```ts
  const [conflictPrompt, setConflictPrompt] = useState<(PlanSummary & { targetLabel: string }) | null>(null)
```

4. Im Bootstrap-`useEffect` die Zeile `window.api.transfers.list()…` und den `return window.api.transfers.onUpdate(…)`-Block ersetzen durch:

```ts
    window.api.queue.list().then(setQueue).catch(() => undefined)
    return window.api.queue.onUpdate(setQueue)
```

5. Direkt nach der Definition `const refresh = useCallback(…)` einfügen:

```ts
  // a job that wrote into the open bucket shows up without a manual refresh
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const openBucket = useRef({ accountId, bucket })
  openBucket.current = { accountId, bucket }
  useEffect(
    () =>
      window.api.queue.onJobDone(({ target }) => {
        const open = openBucket.current
        if (target.type === 's3' && target.accountId === open.accountId && target.bucket === open.bucket) {
          refreshRef.current()
        }
      }),
    []
  )
```

6. Die Funktion `uploadPaths` vollständig ersetzen durch:

```ts
  /** Plan a transfer, ask once about targets that already exist, then hand it to the queue. */
  async function startJob(req: JobRequest, targetLabel: string): Promise<void> {
    try {
      const plan = await window.api.queue.plan(req)
      if (plan.conflicts > 0) {
        setConflictPrompt({ ...plan, targetLabel })
        return
      }
      await window.api.queue.enqueue(plan.planId, 'overwrite')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function resolveConflict(mode: ConflictMode): Promise<void> {
    const prompt = conflictPrompt
    setConflictPrompt(null)
    if (!prompt) return
    try {
      await window.api.queue.enqueue(prompt.planId, mode)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function uploadPaths(paths: string[]): Promise<void> {
    if (!accountId || !bucket || paths.length === 0) return
    await startJob({ kind: 'upload', accountId, bucket, prefix, paths }, `${bucket}/${prefix}`)
  }
```

7. Die Funktion `handleDownload` vollständig ersetzen durch:

```ts
  async function handleDownload(): Promise<void> {
    if (!accountId || !bucket || selectedEntries.length === 0) return
    const dest = await window.api.dialog.pickDestination()
    if (!dest) return
    await startJob(
      {
        kind: 'download',
        accountId,
        bucket,
        entries: selectedEntries.map((e) => ({ key: e.key, type: e.type, size: e.size })),
        destDir: dest
      },
      dest
    )
  }
```

8. Die Funktionen `startCopy` **und** `handleCopy` vollständig ersetzen durch:

```ts
  async function handleCopy(targetAccountId: string, targetBucket: string, targetPrefix: string): Promise<void> {
    if (!accountId || !bucket || selectedEntries.length === 0) return
    setShowCopyDialog(false)
    await startJob(
      {
        kind: 'copy',
        accountId,
        bucket,
        entries: selectedEntries.map((e) => ({ key: e.key, type: e.type, size: e.size })),
        target: { accountId: targetAccountId, bucket: targetBucket, prefix: targetPrefix }
      },
      `${targetBucket}/${targetPrefix}`
    )
  }
```

9. Die Funktion `handleSyncBucket` vollständig ersetzen durch:

```ts
  async function handleSyncBucket(
    targetAccountId: string,
    targetBucket: string,
    targetPrefix: string,
    skipExisting: boolean
  ): Promise<void> {
    if (!copyBucket) return
    const src = copyBucket
    setCopyBucket(null)
    try {
      const plan = await window.api.queue.plan({
        kind: 'sync',
        accountId: src.accountId,
        bucket: src.bucket,
        prefix: '',
        target: { accountId: targetAccountId, bucket: targetBucket, prefix: targetPrefix }
      })
      // a sync decides per object while it runs; the checkbox is its conflict choice
      await window.api.queue.enqueue(plan.planId, skipExisting ? 'skip' : 'overwrite')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
```

10. Das JSX-Element `<TransferPanel … />` ersetzen durch:

```tsx
        <TransferPanel
          queue={queue}
          onPauseAll={() => void window.api.queue.pauseAll()}
          onResumeAll={() => void window.api.queue.resumeAll()}
          onPauseJob={(id) => void window.api.queue.pauseJob(id)}
          onResumeJob={(id) => void window.api.queue.resumeJob(id)}
          onCancelJob={(id) => void window.api.queue.cancelJob(id)}
          onCancelItem={(id, index) => void window.api.queue.cancelItem(id, index)}
          onClear={() => void window.api.queue.clearFinished()}
          onReveal={(id) => void window.api.queue.revealJob(id)}
        />
```

11. Den Block `{conflictPrompt && ( <ConflictDialog … /> )}` ersetzen durch:

```tsx
      {conflictPrompt && (
        <ConflictDialog
          conflicts={conflictPrompt.conflicts}
          total={conflictPrompt.total ?? conflictPrompt.conflicts}
          sample={conflictPrompt.sample}
          targetLabel={conflictPrompt.targetLabel}
          onCancel={() => setConflictPrompt(null)}
          onOverwrite={() => void resolveConflict('overwrite')}
          onSkip={() => void resolveConflict('skip')}
        />
      )}
```

- [ ] **Step 9: Tests, Typecheck, Build**

Run: `npm test && npm run build`
Expected: alle Tests grün; Typecheck (Main, Preload, Renderer) grün; Build erzeugt `out/`. `grep -rn "transfer:\|shell:showItem\|window.api.transfers" src` findet nichts mehr.

- [ ] **Step 10: Ende-zu-Ende gegen einen lokalen S3-Server (nicht committet)**

`<scratchpad>/e2e/fake-s3.cjs` — ein minimaler S3-kompatibler Server: `GET /` (ListBuckets), `GET /demo?list-type=2` (ListObjectsV2 mit Prefix/Delimiter/StartAfter/Paging), `HEAD`/`GET /demo/<key>`, `PUT /demo/<key>` (Upload, 150 ms Verzögerung, zählt gleichzeitige PUTs) und `PUT` mit `x-amz-copy-source` (CopyObject):

```js
const http = require('node:http')

function createFakeS3({ putDelayMs = 150 } = {}) {
  const objects = new Map() // key -> { size, body }
  const log = []
  let inFlightPuts = 0
  let maxInFlightPuts = 0
  const xml = (b) => `<?xml version="1.0" encoding="UTF-8"?>\n${b}`
  const NS = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"'
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  function list(q) {
    const prefix = q.get('prefix') ?? ''
    const delim = q.get('delimiter') ?? ''
    const max = Number(q.get('max-keys') ?? 1000)
    const token = q.get('continuation-token')
    const after = token ? undefined : q.get('start-after') ?? undefined
    const start = Number(token ?? 0)
    const keys = [...objects.keys()].sort()
    const rows = []
    const seen = new Set()
    for (const key of keys) {
      if (!key.startsWith(prefix) || (after !== undefined && key <= after)) continue
      const rest = key.slice(prefix.length)
      const cut = delim ? rest.indexOf(delim) : -1
      if (cut === -1) rows.push({ key })
      else {
        const cp = prefix + rest.slice(0, cut + 1)
        if (!seen.has(cp)) { seen.add(cp); rows.push({ cp }) }
      }
    }
    const page = rows.slice(start, start + max)
    const truncated = start + max < rows.length
    return xml(`<ListBucketResult ${NS}><Name>demo</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>` +
      page.map((r) => r.key
        ? `<Contents><Key>${esc(r.key)}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>&quot;e&quot;</ETag><Size>${objects.get(r.key).size}</Size><StorageClass>STANDARD</StorageClass></Contents>`
        : `<CommonPrefixes><Prefix>${esc(r.cp)}</Prefix></CommonPrefixes>`).join('') +
      (truncated ? `<NextContinuationToken>${start + max}</NextContinuationToken>` : '') + `</ListBucketResult>`)
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const path = decodeURIComponent(url.pathname)
    const q = url.searchParams
    log.push({ t: Date.now(), method: req.method, path })
    const send = (code, body = '', headers = {}) => { res.writeHead(code, { 'content-type': 'application/xml', ...headers }); res.end(body) }
    if (path === '/' && req.method === 'GET') {
      return send(200, xml(`<ListAllMyBucketsResult ${NS}><Owner><ID>1</ID><DisplayName>t</DisplayName></Owner><Buckets><Bucket><Name>demo</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>`))
    }
    if ((path === '/demo' || path === '/demo/') && req.method === 'GET') return send(200, list(q))
    if (!path.startsWith('/demo/')) return send(404)
    const key = path.slice('/demo/'.length)
    if (req.method === 'HEAD') {
      const o = objects.get(key)
      return o ? send(200, '', { 'content-length': String(o.size), etag: '"e"' }) : send(404)
    }
    if (req.method === 'GET') {
      const o = objects.get(key)
      if (!o) return send(404, xml('<Error><Code>NoSuchKey</Code><Message>Not found</Message></Error>'))
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(o.body.length), etag: '"e"' })
      return res.end(o.body)
    }
    if (req.method === 'PUT' && req.headers['x-amz-copy-source']) {
      const src = decodeURIComponent(String(req.headers['x-amz-copy-source'])).replace(/^\/?demo\//, '')
      const o = objects.get(src)
      if (!o) return send(404, xml('<Error><Code>NoSuchKey</Code><Message>Not found</Message></Error>'))
      objects.set(key, { ...o })
      return send(200, xml(`<CopyObjectResult><ETag>&quot;e&quot;</ETag><LastModified>2026-01-01T00:00:00.000Z</LastModified></CopyObjectResult>`))
    }
    if (req.method === 'PUT') {
      inFlightPuts++
      maxInFlightPuts = Math.max(maxInFlightPuts, inFlightPuts)
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => setTimeout(() => {
        const body = Buffer.concat(chunks)
        objects.set(key, { size: body.length, body })
        inFlightPuts--
        send(200, '', { etag: '"e"' })
      }, putDelayMs))
      return
    }
    send(405)
  })

  return {
    objects, log,
    maxInFlightPuts: () => maxInFlightPuts,
    start: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    stop: () => server.close()
  }
}
module.exports = { createFakeS3 }
```

`<scratchpad>/e2e/queue.cjs` — treibt die gebaute App (`out/main/index.js`) mit eigenem `--user-data-dir`. Hilfsfunktionen und Szenarien:

```js
const { _electron: electron } = require('/Users/mwimmer/WebstormProjects/vereinscockpit/node_modules/playwright-core')
const { mkdtempSync, writeFileSync, existsSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createFakeS3 } = require('./fake-s3.cjs')

const APP = '/Users/mwimmer/WebstormProjects/s3-browser'
const tmp = () => mkdtempSync(join(tmpdir(), 's3b-e2e-'))
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) process.exitCode = 1 }

async function launch(userData) {
  const app = await electron.launch({
    executablePath: require(`${APP}/node_modules/electron`),
    args: [`${APP}/out/main/index.js`, `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ELECTRON_RENDERER_URL: undefined }
  })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await win.waitForLoadState('domcontentloaded')
  return { app, win, errors }
}

const panel = (win) => win.locator('.transfers')
const waitText = (win, text, timeout = 15000) => panel(win).getByText(text).first().waitFor({ timeout })
const snapshot = (win) => win.evaluate(() => window.api.queue.list())
async function enqueue(win, req, mode = 'overwrite') {
  return win.evaluate(async ({ req, mode }) => {
    const plan = await window.api.queue.plan(req)
    return { plan, jobId: await window.api.queue.enqueue(plan.planId, mode) }
  }, { req, mode })
}

;(async () => {
  const s3 = createFakeS3()
  const port = await s3.start()
  const userData = tmp()
  const { app, win, errors } = await launch(userData)
  const accountId = await win.evaluate(async (port) => (await window.api.accounts.save({
    name: 'Fake S3', provider: 'custom', endpoint: `http://127.0.0.1:${port}`, region: 'us-east-1',
    accessKeyId: 'test', secretAccessKey: 'test', forcePathStyle: true, allowInsecureTls: false
  })).id, port)
  await win.reload()
  await win.locator('.tree-item', { hasText: 'Fake S3' }).click()
  await win.locator('.tree-item', { hasText: 'demo' }).click()

  // 1) 30 files: all visible as one job, never more than four at once
  const src = tmp()
  const paths = Array.from({ length: 30 }, (_, i) => { const p = join(src, `file-${String(i).padStart(2, '0')}.txt`); writeFileSync(p, `content ${i}`); return p })
  await enqueue(win, { kind: 'upload', accountId, bucket: 'demo', prefix: 'up/', paths })
  await waitText(win, 'Upload 30 files → demo/up/')
  await waitText(win, 'waiting')
  check('upload job listed with waiting items', true)

  // 2) pause: running items finish, nothing new starts; resume carries on
  await panel(win).getByRole('button', { name: /Pause all/ }).click()
  await win.waitForTimeout(600)
  const putsWhilePaused = s3.log.filter((r) => r.method === 'PUT').length
  await win.waitForTimeout(800)
  check('no new uploads while paused', s3.log.filter((r) => r.method === 'PUT').length === putsWhilePaused)
  await panel(win).getByRole('button', { name: /Resume all/ }).click()
  await waitText(win, '30 / 30')
  check('at most four uploads at once', s3.maxInFlightPuts() <= 4, `max ${s3.maxInFlightPuts()}`)

  // 3) the open bucket refreshes by itself once the job is done
  await win.locator('tr', { hasText: 'up' }).first().waitFor({ timeout: 5000 })
  check('table shows the uploaded folder without a manual refresh', true)

  // 4) download the folder: files land under their folder name
  const dest = tmp()
  await enqueue(win, { kind: 'download', accountId, bucket: 'demo', entries: [{ key: 'up/', type: 'folder' }], destDir: dest })
  await waitText(win, /Download 30 files/)
  await win.waitForFunction(async () => (await window.api.queue.list()).jobs.every((j) => j.finished), null, { timeout: 15000 })
  check('downloaded files exist', existsSync(join(dest, 'up', 'file-07.txt')) && readFileSync(join(dest, 'up', 'file-07.txt'), 'utf8') === 'content 7')

  // 5) copy twice into the same place: the second plan reports every object as a conflict
  await enqueue(win, { kind: 'copy', accountId, bucket: 'demo', entries: [{ key: 'up/', type: 'folder' }], target: { accountId, bucket: 'demo', prefix: 'copy/' } })
  await win.waitForFunction(async () => (await window.api.queue.list()).jobs.every((j) => j.finished), null, { timeout: 15000 })
  const again = await win.evaluate((accountId) => window.api.queue.plan({ kind: 'copy', accountId, bucket: 'demo', entries: [{ key: 'up/', type: 'folder' }], target: { accountId, bucket: 'demo', prefix: 'copy/' } }), accountId)
  check('second copy sees 30 existing objects', again.conflicts === 30, JSON.stringify(again))

  // 6) a job whose connection is deleted fails once, as a whole
  await win.evaluate(() => window.api.queue.pauseAll())
  const other = await win.evaluate(async (port) => (await window.api.accounts.save({
    name: 'Doomed', provider: 'custom', endpoint: `http://127.0.0.1:${port}`, region: 'us-east-1',
    accessKeyId: 'test', secretAccessKey: 'test', forcePathStyle: true, allowInsecureTls: false
  })).id, port)
  await enqueue(win, { kind: 'upload', accountId: other, bucket: 'demo', prefix: 'doomed/', paths: paths.slice(0, 5) })
  await win.evaluate((id) => window.api.accounts.remove(id), other)
  await win.evaluate(() => window.api.queue.resumeAll())
  await waitText(win, 'Failed — The connection used by this job no longer exists')
  const doomed = (await snapshot(win)).jobs.find((j) => j.title.includes('doomed'))
  check('deleted connection fails the job once', doomed.items.failed === 1 && doomed.finished, JSON.stringify(doomed.items))

  check('no renderer errors', errors.length === 0, errors.join(' | '))
  await app.close()
  s3.stop()
})().catch((e) => { console.error('E2E FAILED', e); process.exit(1) })
```

Run: `npm run build && cd <scratchpad>/e2e && env -u ELECTRON_RUN_AS_NODE node queue.cjs`
Expected: jede Zeile `PASS`. Schlägt eine Zeile fehl: mit systematic-debugging die Ursache klären — zuerst prüfen, ob der Fake-Server die Anfrage korrekt beantwortet (siehe `s3.log`), bevor App-Code geändert wird.

- [ ] **Step 11: Commit und Push von Etappe 1**

```bash
git add -A src/main src/preload src/shared src/renderer
git commit -m "Route every transfer through the queue and show jobs in the panel"
git push origin main
```

Danach im CI-Lauf prüfen, dass `npm test` und die drei Plattform-Builds grün sind (`gh run list --limit 1`).

---

# Etappe 2 — Speichern und Wiederherstellen

### Task 6: Queue-Speicher

**Files:**
- Create: `src/main/queueStore.ts`
- Test: `src/main/queueStore.test.ts`

**Interfaces:**
- Consumes: `JobKind`, `JobTarget`, `ConflictMode` (`@shared/types`).
- Produces:
  - `interface StoredItem { index: number; name: string; size: number; data: unknown }`
  - `interface StoredJob { version: 1; id: string; kind: JobKind; title: string; target: JobTarget; createdAt: number; conflict: ConflictMode; spec: unknown; items: StoredItem[] | null }`
  - `interface ItemOutcome { status: 'done' | 'skipped' | 'error' | 'cancelled'; error?: string }`
  - `interface ResumeMark { items: number; bytes: number; key: string }`
  - `interface RestoredJob { job: StoredJob; paused: boolean; outcomes: Map<number, ItemOutcome>; mark?: ResumeMark }`
  - `createQueueStore(dir: string)` → `{ create(job), settle(id, index, outcome), paused(id, paused), mark(id, mark), remove(id), loadAll(): RestoredJob[] }`; `type QueueStore = ReturnType<typeof createQueueStore>`

- [ ] **Step 1: Tests schreiben**

`src/main/queueStore.test.ts`:

```ts
import { appendFileSync, existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createQueueStore, type StoredJob } from './queueStore'

const queueDir = (): string => join(mkdtempSync(join(tmpdir(), 's3b-queue-')), 'queue')

const job = (id = 'job-1', extra: Partial<StoredJob> = {}): StoredJob => ({
  version: 1,
  id,
  kind: 'upload',
  title: 'Upload 3 files → b/',
  target: { type: 's3', accountId: 'a', bucket: 'b', prefix: '' },
  createdAt: 1,
  conflict: 'skip',
  spec: { accountId: 'a', bucket: 'b', prefix: '' },
  items: [0, 1, 2].map((index) => ({
    index,
    name: `f${index}`,
    size: 10,
    data: { file: `/f${index}`, key: `f${index}` }
  })),
  ...extra
})

describe('queue store', () => {
  it('brings a job back with what had already happened to its items', () => {
    const dir = queueDir()
    const store = createQueueStore(dir)
    store.create(job())
    store.settle('job-1', 0, { status: 'done' })
    store.settle('job-1', 2, { status: 'error', error: 'Access Denied' })

    const [restored] = createQueueStore(dir).loadAll()

    expect(restored.job).toEqual(job())
    expect([...restored.outcomes]).toEqual([
      [0, { status: 'done' }],
      [2, { status: 'error', error: 'Access Denied' }]
    ])
  })

  it('ignores a log line that a crash cut short', () => {
    const dir = queueDir()
    const store = createQueueStore(dir)
    store.create(job())
    store.settle('job-1', 0, { status: 'done' })
    appendFileSync(join(dir, 'job-1.log'), '1 do')

    expect([...store.loadAll()[0].outcomes.keys()]).toEqual([0])
  })

  it('remembers whether the user had paused a job', () => {
    const store = createQueueStore(queueDir())
    store.create(job('a'))
    store.create(job('b', { createdAt: 2 }))
    store.paused('a', true)
    store.paused('b', true)
    store.paused('b', false)

    expect(store.loadAll().map((r) => [r.job.id, r.paused])).toEqual([
      ['a', true],
      ['b', false]
    ])
  })

  it('keeps the latest resume mark, whatever its key contains', () => {
    const store = createQueueStore(queueDir())
    store.create(job('s', { kind: 'sync', items: null }))
    store.mark('s', { items: 1, bytes: 10, key: 'a' })
    store.mark('s', { items: 7, bytes: 70, key: 'dir with spaces/line\nbreak.txt' })

    expect(store.loadAll()[0].mark).toEqual({ items: 7, bytes: 70, key: 'dir with spaces/line\nbreak.txt' })
  })

  it('keeps an error message on one line', () => {
    const store = createQueueStore(queueDir())
    store.create(job())
    store.settle('job-1', 1, { status: 'error', error: 'first\nsecond' })

    expect(store.loadAll()[0].outcomes.get(1)).toEqual({ status: 'error', error: 'first second' })
  })

  it('forgets a removed job', () => {
    const store = createQueueStore(queueDir())
    store.create(job())
    store.settle('job-1', 0, { status: 'done' })

    store.remove('job-1')

    expect(store.loadAll()).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('writes files only the user can read', () => {
    const dir = queueDir()
    const store = createQueueStore(dir)
    store.create(job())
    store.settle('job-1', 0, { status: 'done' })

    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'job-1.job.json')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'job-1.log')).mode & 0o777).toBe(0o600)
  })

  it('drops a job file it cannot read and keeps the others', () => {
    const dir = queueDir()
    const store = createQueueStore(dir)
    store.create(job('good'))
    writeFileSync(join(dir, 'bad.job.json'), '{ not json')

    expect(store.loadAll().map((r) => r.job.id)).toEqual(['good'])
    expect(existsSync(join(dir, 'bad.job.json'))).toBe(false)
  })

  it('refuses a job id that is not a safe file name', () => {
    expect(() => createQueueStore(queueDir()).create(job('../evil'))).toThrow()
  })

  it('has nothing to restore before anything was saved', () => {
    expect(createQueueStore(queueDir()).loadAll()).toEqual([])
  })
})
```

- [ ] **Step 2: Fehlschlag prüfen**

Run: `npx vitest run src/main/queueStore.test.ts`
Expected: FAIL — `Failed to resolve import "./queueStore"`.

- [ ] **Step 3: Speicher implementieren**

`src/main/queueStore.ts`:

```ts
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
```

- [ ] **Step 4: Tests laufen lassen**

Run: `npm test && npm run typecheck`
Expected: PASS (10 neue Tests; auf Windows 9, der Rechte-Test wird übersprungen).

- [ ] **Step 5: Mutationsprüfung**

- In `loadAll` `lines.pop()` entfernen → „ignores a log line that a crash cut short" scheitert.
- In `mark` `JSON.stringify(mark.key)` durch `mark.key` ersetzen → „keeps the latest resume mark…" scheitert.
- In `create` die `mode`-Option entfernen → Rechte-Test scheitert (außer Windows).

- [ ] **Step 6: Commit**

```bash
git add src/main/queueStore.ts src/main/queueStore.test.ts
git commit -m "Add a queue store that writes each job once and appends its progress"
```

---

### Task 7: Speichern und Wiederherstellen verdrahten

**Files:**
- Modify: `src/main/queueService.ts` (vollständig ersetzen), `src/main/queueService.test.ts`
- Modify: `src/main/ipc.ts`, `src/preload/index.ts`
- Modify: `src/renderer/src/components/TransferPanel.tsx`, `src/renderer/src/App.tsx`, `src/renderer/src/styles.css`
- Verification (nicht committet): Neustart-Szenario in `<scratchpad>/e2e/restart.cjs`

**Interfaces:**
- Consumes: `createQueueStore`, `QueueStore`, `RestoredJob` (Task 6); alles aus Task 4.
- Produces:
  - `createQueueService` bekommt die Pflicht-Abhängigkeit `store: QueueStore` und zusätzlich `init(): void` sowie `restore(decision: 'resume' | 'discard'): Promise<void>`; `snapshot().restore` ist `{ jobs, items } | null`.
  - `JobFactory` bekommt die optionale Methode `recheck?(kind: JobKind, spec: unknown, items: QueueItem[]): Promise<number[]>` (implementiert in Task 9).
  - Renderer-API: `window.api.queue.restore(decision): Promise<void>`; `TransferPanel` bekommt die Prop `onRestore(decision: 'resume' | 'discard'): void`.

- [ ] **Step 1: Test-Hilfen erweitern und neue Tests schreiben**

In `src/main/queueService.test.ts`:

1. Importe ergänzen:

```ts
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JobKind } from '@shared/types'
import { createQueueStore } from './queueStore'
```

2. Die Hilfsfunktion `service` ersetzen durch:

```ts
const queueDir = (): string => join(mkdtempSync(join(tmpdir(), 's3b-svc-')), 'queue')

/** A queue service on a store folder; a second call on the same folder is a restart. */
function service(factory: JobFactory, throttleMs = 0, dir = queueDir()) {
  const snapshots: QueueSnapshot[] = []
  const done = vi.fn()
  const svc = createQueueService({
    factory,
    store: createQueueStore(dir),
    emit: (s) => snapshots.push(s),
    onJobDone: done,
    newId: () => randomUUID(),
    now: () => 1,
    throttleMs
  })
  svc.init()
  return { svc, snapshots, done }
}

/** A factory whose items finish only when the test says so. */
function manualFactory(opts: { kind?: JobKind; lazy?: boolean; recheck?: number[]; recheckFails?: boolean } = {}) {
  const live = new Map<number, () => void>()
  const started: number[] = []
  const startAfter: (string | undefined)[] = []
  const factory: JobFactory = {
    plan: async () => ({
      kind: opts.lazy ? 'sync' : (opts.kind ?? 'upload'),
      title: 'Job',
      target: { type: 's3', accountId: 'a', bucket: 'b', prefix: '' },
      items: opts.lazy ? null : items(3),
      conflicts: [],
      sample: [],
      spec: { note: 'kept' }
    }),
    runtime: (job) => {
      startAfter.push(job.startAfter)
      const run = (item: QueueItem) =>
        new Promise<'done'>((resolve) => {
          started.push(item.index)
          live.set(item.index, () => resolve('done'))
        })
      if (!opts.lazy) return { run }
      return { run, source: arraySource(items(3)), onSettled: (index) => `key${index}` }
    },
    ...(opts.recheck || opts.recheckFails
      ? {
          recheck: async () => {
            if (opts.recheckFails) throw new Error('network down')
            return opts.recheck ?? []
          }
        }
      : {})
  }
  return { factory, live, started, startAfter }
}
```

3. Am Ende der Datei anhängen:

```ts
describe('queue service across restarts', () => {
  it('offers an unfinished job after a restart and resumes only what was left', async () => {
    const dir = queueDir()
    const first = manualFactory()
    const one = service(first.factory, 0, dir)
    one.svc.enqueue((await one.svc.plan(request)).planId, 'overwrite')
    first.live.get(0)!()
    await settle()

    const second = manualFactory()
    const two = service(second.factory, 0, dir)
    expect(two.svc.snapshot().restore).toEqual({ jobs: 1, items: 2 })
    await two.svc.restore('resume')

    // item 1 was still running when the app quit: it starts over
    expect(second.started).toEqual([1, 2])
    expect(two.svc.snapshot().jobs[0].items).toMatchObject({ total: 3, done: 1, running: 2 })
    expect(two.svc.snapshot().restore).toBeNull()
  })

  it('keeps a job the user had paused paused when resuming', async () => {
    const dir = queueDir()
    const one = service(manualFactory().factory, 0, dir)
    const jobId = one.svc.enqueue((await one.svc.plan(request)).planId, 'overwrite')
    one.svc.pauseJob(jobId)

    const second = manualFactory()
    const two = service(second.factory, 0, dir)
    await two.svc.restore('resume')

    expect(two.svc.snapshot().jobs[0].paused).toBe(true)
    expect(second.started).toEqual([])
  })

  it('forgets the saved jobs when told to discard them', async () => {
    const dir = queueDir()
    const one = service(manualFactory().factory, 0, dir)
    one.svc.enqueue((await one.svc.plan(request)).planId, 'overwrite')

    await service(manualFactory().factory, 0, dir).svc.restore('discard')

    expect(service(manualFactory().factory, 0, dir).svc.snapshot().restore).toBeNull()
  })

  it('offers the jobs again when the previous start never decided', async () => {
    const dir = queueDir()
    const one = service(manualFactory().factory, 0, dir)
    one.svc.enqueue((await one.svc.plan(request)).planId, 'overwrite')

    service(manualFactory().factory, 0, dir) // started and quit again without choosing

    expect(service(manualFactory().factory, 0, dir).svc.snapshot().restore).toEqual({ jobs: 1, items: 3 })
  })

  it('leaves nothing to restore once a job has finished', async () => {
    const dir = queueDir()
    const first = manualFactory()
    const one = service(first.factory, 0, dir)
    one.svc.enqueue((await one.svc.plan(request)).planId, 'overwrite')
    for (const finish of [...first.live.values()]) finish()
    await settle()

    expect(service(manualFactory().factory, 0, dir).svc.snapshot().restore).toBeNull()
  })

  it('continues a bucket sync after its last mark', async () => {
    const dir = queueDir()
    const first = manualFactory({ lazy: true })
    const one = service(first.factory, 0, dir)
    one.svc.enqueue((await one.svc.plan(request)).planId, 'skip')
    first.live.get(0)!()
    first.live.get(1)!()
    await settle()

    const second = manualFactory({ lazy: true })
    const two = service(second.factory, 0, dir)
    await two.svc.restore('resume')

    expect(second.startAfter).toEqual(['key1'])
    expect(two.svc.snapshot().jobs[0].items).toMatchObject({ done: 2 })
  })

  it('checks a skip job again before resuming it and skips what appeared meanwhile', async () => {
    const dir = queueDir()
    const one = service(manualFactory().factory, 0, dir)
    one.svc.enqueue((await one.svc.plan(request)).planId, 'skip')

    const second = manualFactory({ recheck: [2] })
    const two = service(second.factory, 0, dir)
    await two.svc.restore('resume')

    expect(second.started).toEqual([0, 1])
    expect(two.svc.snapshot().jobs[0].items).toMatchObject({ total: 3, skipped: 1 })
  })

  it('keeps a job on offer when checking it again fails', async () => {
    const dir = queueDir()
    const one = service(manualFactory().factory, 0, dir)
    one.svc.enqueue((await one.svc.plan(request)).planId, 'skip')

    const two = service(manualFactory({ recheckFails: true }).factory, 0, dir)

    await expect(two.svc.restore('resume')).rejects.toThrow('could not be resumed: network down')
    expect(two.svc.snapshot().restore).toEqual({ jobs: 1, items: 3 })
  })
})
```

- [ ] **Step 2: Fehlschlag prüfen**

Run: `npx vitest run src/main/queueService.test.ts`
Expected: FAIL — Typfehler bzw. `svc.init is not a function`, danach an den Assertions der neuen Tests.

- [ ] **Step 3: Queue-Service vollständig ersetzen**

`src/main/queueService.ts`:

```ts
import type {
  ConflictMode,
  JobDoneEvent,
  JobKind,
  JobRequest,
  JobTarget,
  PlanSummary,
  QueueSnapshot
} from '@shared/types'
import type { QueueStore, RestoredJob } from './queueStore'
import {
  arraySource,
  createTransferQueue,
  type ItemSource,
  type QueueItem,
  type RunContext,
  type Settled
} from './transferQueue'

export interface PlannedJob {
  kind: JobKind
  title: string
  target: JobTarget
  /** every item, known up front; null when the job lists its items as it goes (bucket sync) */
  items: QueueItem[] | null
  /** indices of items whose target already exists */
  conflicts: number[]
  /** a few conflicting target names for the dialog */
  sample: string[]
  /** what the factory needs to rebuild the job's runner, e.g. after a restart */
  spec: unknown
}

export interface JobRuntime {
  run(item: QueueItem, ctx: RunContext): Promise<'done' | 'skipped'>
  /** jobs that list their items as they go bring their own source */
  source?: ItemSource
  /** told about every settled item; returns a new resume mark when it moved */
  onSettled?(index: number): string | undefined
}

export interface RuntimeRequest {
  id: string
  kind: JobKind
  spec: unknown
  conflict: ConflictMode
  /** bucket sync: continue listing after this key */
  startAfter?: string
}

export interface JobFactory {
  plan(req: JobRequest): Promise<PlannedJob>
  runtime(job: RuntimeRequest, wake: () => void): JobRuntime
  /** which of these items' targets exist now; asked before resuming a "skip existing" job */
  recheck?(kind: JobKind, spec: unknown, items: QueueItem[]): Promise<number[]>
}

/** Ties the scheduler to the transfers it runs, the store that keeps them and the renderer. */
export function createQueueService(deps: {
  factory: JobFactory
  store: QueueStore
  emit(snapshot: QueueSnapshot): void
  onJobDone(event: JobDoneEvent): void
  newId(): string
  now(): number
  /** minimum gap between snapshots; the end of a job is never held back */
  throttleMs?: number
}) {
  const throttleMs = deps.throttleMs ?? 120
  const runtimes = new Map<string, JobRuntime>()
  const targets = new Map<string, { kind: JobKind; target: JobTarget }>()
  /** done and skipped totals of listing jobs, written along with each resume mark */
  const listed = new Map<string, { items: number; bytes: number }>()
  // only the newest plan can be started; an older one has lost its dialog
  let pending: { id: string; planned: PlannedJob } | undefined
  let restorable: RestoredJob[] = []
  let timer: ReturnType<typeof setTimeout> | undefined

  const queue = createTransferQueue({
    onChange: scheduleEmit,
    onItemSettled: (jobId, item, status, error) => {
      const runtime = runtimes.get(jobId)
      if (!runtime) return
      if (!runtime.source) {
        deps.store.settle(jobId, item.index, error === undefined ? { status } : { status, error })
        return
      }
      const progress = listed.get(jobId)
      if (progress && (status === 'done' || status === 'skipped')) {
        progress.items++
        progress.bytes += item.size
      }
      const key = runtime.onSettled?.(item.index)
      if (key !== undefined && progress) deps.store.mark(jobId, { ...progress, key })
    },
    onJobPausedChanged: (jobId, paused) => deps.store.paused(jobId, paused),
    onJobFinished: (jobId) => {
      deps.store.remove(jobId)
      runtimes.delete(jobId)
      listed.delete(jobId)
      const info = targets.get(jobId)
      if (info) deps.onJobDone({ jobId, ...info })
      emitNow()
    }
  })

  function snapshot(): QueueSnapshot {
    const waiting = (r: RestoredJob): number =>
      r.job.items ? r.job.items.filter((i) => !r.outcomes.has(i.index)).length : 0
    return {
      paused: queue.isPaused(),
      jobs: queue.view(),
      restore:
        restorable.length === 0
          ? null
          : { jobs: restorable.length, items: restorable.reduce((sum, r) => sum + waiting(r), 0) }
    }
  }

  function emitNow(): void {
    if (timer) clearTimeout(timer)
    timer = undefined
    deps.emit(snapshot())
  }

  function scheduleEmit(): void {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      deps.emit(snapshot())
    }, throttleMs)
  }

  const wake = (): void => {
    queue.wake()
    scheduleEmit()
  }

  function register(id: string, kind: JobKind, target: JobTarget, runtime: JobRuntime): void {
    runtimes.set(id, runtime)
    targets.set(id, { kind, target })
  }

  /** Put a job from the previous session back on the queue, past everything it had settled. */
  async function resume(r: RestoredJob): Promise<void> {
    const { job } = r
    const remaining: QueueItem[] = []
    const settled: Settled = { done: 0, skipped: 0, cancelled: 0, bytes: 0, failed: [] }
    let settledBytes = 0
    for (const stored of job.items ?? []) {
      const item: QueueItem = { index: stored.index, name: stored.name, size: stored.size, data: stored.data }
      const outcome = r.outcomes.get(stored.index)
      if (!outcome) {
        remaining.push(item)
        continue
      }
      settledBytes += item.size
      if (outcome.status === 'done') {
        settled.done++
        settled.bytes += item.size
      } else if (outcome.status === 'skipped') {
        settled.skipped++
        settled.bytes += item.size
      } else if (outcome.status === 'cancelled') {
        settled.cancelled++
      } else {
        settled.failed.push({ item, error: outcome.error ?? 'Unknown error' })
      }
    }

    // the answer from before the restart is stale: look at the targets again
    let runnable = remaining
    if (job.conflict === 'skip' && job.items && remaining.length > 0 && deps.factory.recheck) {
      const exists = new Set(await deps.factory.recheck(job.kind, job.spec, remaining))
      runnable = remaining.filter((i) => !exists.has(i.index))
      for (const item of remaining) {
        if (!exists.has(item.index)) continue
        settled.skipped++
        settled.bytes += item.size
        settledBytes += item.size
        deps.store.settle(job.id, item.index, { status: 'skipped' })
      }
    }

    const runtime = deps.factory.runtime(
      { id: job.id, kind: job.kind, spec: job.spec, conflict: job.conflict, startAfter: r.mark?.key },
      wake
    )
    let source: ItemSource
    if (job.items) {
      source = arraySource(runnable, { items: job.items.length - runnable.length, bytes: settledBytes })
    } else {
      if (!runtime.source) throw new Error(`Cannot resume "${job.title}"`)
      source = runtime.source
      settled.done = r.mark?.items ?? 0
      settled.bytes = r.mark?.bytes ?? 0
      listed.set(job.id, { items: settled.done, bytes: settled.bytes })
    }
    register(job.id, job.kind, job.target, runtime)
    queue.add({
      id: job.id,
      kind: job.kind,
      title: job.title,
      target: job.target,
      createdAt: job.createdAt,
      paused: r.paused,
      source,
      run: runtime.run,
      settled
    })
  }

  return {
    /** read what the previous session left unfinished; offered until restore() decides */
    init(): void {
      restorable = deps.store.loadAll()
    },

    async restore(decision: 'resume' | 'discard'): Promise<void> {
      const jobs = restorable
      restorable = []
      if (decision === 'discard') {
        for (const r of jobs) deps.store.remove(r.job.id)
        emitNow()
        return
      }
      const failed: { r: RestoredJob; message: string }[] = []
      for (const r of jobs) {
        try {
          await resume(r)
        } catch (err) {
          failed.push({ r, message: err instanceof Error ? err.message : String(err) })
        }
      }
      // a job that could not be resumed stays on offer instead of being lost
      restorable = failed.map((f) => f.r)
      emitNow()
      if (failed.length > 0) {
        const n = failed.length
        throw new Error(`${n} job${n === 1 ? '' : 's'} could not be resumed: ${failed[0].message}`)
      }
    },

    async plan(req: JobRequest): Promise<PlanSummary> {
      const planned = await deps.factory.plan(req)
      pending = { id: deps.newId(), planned }
      return {
        planId: pending.id,
        total: planned.items ? planned.items.length : null,
        conflicts: planned.conflicts.length,
        sample: planned.sample
      }
    },

    enqueue(planId: string, mode: ConflictMode): string {
      if (!pending || pending.id !== planId) {
        throw new Error('This transfer was already started or has expired — please start it again')
      }
      const { planned } = pending
      pending = undefined
      const id = deps.newId()
      const createdAt = deps.now()
      const runtime = deps.factory.runtime({ id, kind: planned.kind, spec: planned.spec, conflict: mode }, wake)
      register(id, planned.kind, planned.target, runtime)

      const skip = new Set(mode === 'skip' ? planned.conflicts : [])
      const all = planned.items ?? []
      const skipped = all.filter((i) => skip.has(i.index))
      const skippedBytes = skipped.reduce((sum, i) => sum + i.size, 0)

      deps.store.create({
        version: 1,
        id,
        kind: planned.kind,
        title: planned.title,
        target: planned.target,
        createdAt,
        conflict: mode,
        spec: planned.spec,
        items: planned.items
          ? planned.items.map(({ index, name, size, data }) => ({ index, name, size, data }))
          : null
      })
      for (const item of skipped) deps.store.settle(id, item.index, { status: 'skipped' })
      if (runtime.source) listed.set(id, { items: 0, bytes: 0 })

      queue.add({
        id,
        kind: planned.kind,
        title: planned.title,
        target: planned.target,
        createdAt,
        source:
          runtime.source ??
          arraySource(
            all.filter((i) => !skip.has(i.index)),
            { items: skipped.length, bytes: skippedBytes }
          ),
        run: runtime.run,
        settled: { done: 0, skipped: skipped.length, cancelled: 0, bytes: skippedBytes, failed: [] }
      })
      return id
    },

    pauseAll: (): void => queue.pauseAll(),
    resumeAll: (): void => queue.resumeAll(),
    pauseJob: (id: string): void => queue.pauseJob(id),
    resumeJob: (id: string): void => queue.resumeJob(id),
    cancelJob: (id: string): void => queue.cancelJob(id),
    cancelItem: (id: string, index: number): void => queue.cancelItem(id, index),

    clearFinished(): void {
      queue.clearFinished()
      for (const id of [...targets.keys()]) if (!queue.has(id)) targets.delete(id)
    },

    snapshot,

    /** the local folder a download job writes to, for "Show in folder" */
    revealDir(id: string): string | undefined {
      const target = targets.get(id)?.target
      return target?.type === 'local' ? target.dir : undefined
    }
  }
}
```

- [ ] **Step 4: Tests laufen lassen**

Run: `npm test && npm run typecheck`
Expected: PASS — die bisherigen 8 Service-Tests (jetzt mit echtem Speicher) und die 8 neuen.

- [ ] **Step 5: IPC und Preload**

In `src/main/ipc.ts`:
1. `app` zum Electron-Import hinzufügen; `import { join } from 'node:path'` und `import { createQueueStore } from './queueStore'` ergänzen.
2. In `createQueueService({ … })` nach `factory: …,` einfügen:

```ts
    store: createQueueStore(join(app.getPath('userData'), 'queue')),
```

3. Direkt nach dem `createQueueService(…)`-Aufruf:

```ts
  // unfinished jobs from the previous session are offered, never started unasked
  queue.init()
```

4. Nach `wrap('queue:clearFinished', …)`:

```ts
  wrap('queue:restore', (decision: unknown) => {
    if (decision !== 'resume' && decision !== 'discard') throw new Error('Invalid choice')
    return queue.restore(decision)
  })
```

In `src/preload/index.ts` im Block `queue` nach `clearFinished`:

```ts
    restore: (decision: 'resume' | 'discard') => call<void>('queue:restore', decision),
```

- [ ] **Step 6: Wiederherstellen-Leiste im Panel**

In `src/renderer/src/components/TransferPanel.tsx`:
1. Im `Props`-Interface ergänzen: `onRestore(decision: 'resume' | 'discard'): void`.
2. Im `JobRow`-Prop-Typ `Omit<Props, 'queue' | 'onPauseAll' | 'onResumeAll' | 'onClear'>` um `| 'onRestore'` erweitern.
3. Über `export default function TransferPanel` einfügen:

```tsx
function restoreText(r: { jobs: number; items: number }): string {
  const jobs = `${r.jobs} unfinished job${r.jobs === 1 ? '' : 's'} from last time`
  return r.items > 0 ? `${jobs} — ${r.items.toLocaleString()} transfer${r.items === 1 ? '' : 's'} waiting` : jobs
}
```

4. `if (queue.jobs.length === 0) return null` ersetzen durch `if (queue.jobs.length === 0 && !queue.restore) return null`.
5. Direkt nach dem schließenden `</div>` von `transfers-head` einfügen:

```tsx
      {queue.restore && (
        <div className="restore-bar">
          <span>{restoreText(queue.restore)}</span>
          <span className="spacer" />
          <button className="primary" onClick={() => props.onRestore('resume')}>
            Resume
          </button>
          <button className="ghost" onClick={() => props.onRestore('discard')}>
            Discard
          </button>
        </div>
      )}
```

In `src/renderer/src/styles.css` nach `.job-upcoming .more { … }`:

```css
.restore-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 12px 8px;
  padding: 7px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--bg-elev-2);
  font-size: 12px;
  color: var(--text-dim);
}
```

In `src/renderer/src/App.tsx` dem `<TransferPanel>` die Prop hinzufügen:

```tsx
          onRestore={(decision) =>
            void window.api.queue
              .restore(decision)
              .catch((e) => setError(e instanceof Error ? e.message : String(e)))
          }
```

- [ ] **Step 7: Build und Neustart-Szenario (nicht committet)**

`<scratchpad>/e2e/restart.cjs` — beendet die App mitten in einem Upload, startet sie mit demselben Nutzerordner neu und prüft das Wiederherstellen:

```js
const { _electron: electron } = require('/Users/mwimmer/WebstormProjects/vereinscockpit/node_modules/playwright-core')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createFakeS3 } = require('./fake-s3.cjs')

const APP = '/Users/mwimmer/WebstormProjects/s3-browser'
const tmp = () => mkdtempSync(join(tmpdir(), 's3b-e2e-'))
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) process.exitCode = 1 }

async function launch(userData) {
  const app = await electron.launch({
    executablePath: require(`${APP}/node_modules/electron`),
    args: [`${APP}/out/main/index.js`, `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ELECTRON_RENDERER_URL: undefined }
  })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await win.waitForLoadState('domcontentloaded')
  return { app, win, errors }
}

;(async () => {
  const s3 = createFakeS3({ putDelayMs: 400 })
  const port = await s3.start()
  const userData = tmp()
  const src = tmp()
  const paths = Array.from({ length: 20 }, (_, i) => {
    const p = join(src, `f-${String(i).padStart(2, '0')}.txt`)
    writeFileSync(p, `c${i}`)
    return p
  })
  const uploaded = () => [...s3.objects.keys()].filter((k) => k.startsWith('up/')).length

  let { app, win, errors } = await launch(userData)
  const accountId = await win.evaluate(async (port) => (await window.api.accounts.save({
    name: 'Fake S3', provider: 'custom', endpoint: `http://127.0.0.1:${port}`, region: 'us-east-1',
    accessKeyId: 'test', secretAccessKey: 'test', forcePathStyle: true, allowInsecureTls: false
  })).id, port)
  const enqueue = (req) => win.evaluate(async (req) => {
    const plan = await window.api.queue.plan(req)
    return window.api.queue.enqueue(plan.planId, 'overwrite')
  }, req)
  await enqueue({ kind: 'upload', accountId, bucket: 'demo', prefix: 'up/', paths })
  const held = await enqueue({ kind: 'upload', accountId, bucket: 'demo', prefix: 'held/', paths: paths.slice(0, 3) })
  await win.evaluate((id) => window.api.queue.pauseJob(id), held)
  for (let i = 0; i < 100 && uploaded() < 3; i++) await win.waitForTimeout(100)
  check('some files uploaded before quitting', uploaded() >= 3, String(uploaded()))
  await app.close()

  ;({ app, win, errors } = await launch(userData))
  const bar = win.locator('.restore-bar')
  await bar.getByText('2 unfinished jobs from last time').waitFor({ timeout: 10000 })
  check('restore bar offered after the restart', true)
  await bar.getByRole('button', { name: 'Resume' }).click()
  await win.waitForFunction(
    async () => (await window.api.queue.list()).jobs.some((j) => j.title.includes('demo/up/') && j.finished),
    null,
    { timeout: 30000 }
  )
  check('all 20 uploaded after the restart', uploaded() === 20, String(uploaded()))
  const heldJob = (await win.evaluate(() => window.api.queue.list())).jobs.find((j) => j.title.includes('demo/held/'))
  check('the job paused before quitting stays paused', heldJob?.paused === true, JSON.stringify(heldJob?.items))
  check('no renderer errors', errors.length === 0, errors.join(' | '))
  await app.close()
  s3.stop()
})().catch((e) => { console.error('E2E FAILED', e); process.exit(1) })
```

Run: `npm run build && cd <scratchpad>/e2e && env -u ELECTRON_RUN_AS_NODE node restart.cjs && node queue.cjs`
Expected: alle Zeilen `PASS`.

- [ ] **Step 8: Commit und Push von Etappe 2**

```bash
git add src/main src/preload src/renderer
git commit -m "Keep the transfer queue across restarts and offer to resume it"
git push origin main
```

---

# Etappe 3 — Konfliktabfragen

### Task 8: Gezielte Zielprüfung

**Files:**
- Create: `src/main/conflicts.ts`
- Test: `src/main/conflicts.test.ts`

**Interfaces:**
- Consumes: `localPathFor` (Task 3); `fakeS3`, `httpError` (Task 2).
- Produces:
  - `interface Sender { send(command: object, options?: { abortSignal?: AbortSignal }): Promise<unknown> }`
  - `interface Probe { head(key: string): Promise<boolean>; list(prefix: string, wanted: Set<string>): Promise<string[]> }`
  - `type TargetCheck = { head: string } | { list: string; keys: string[] }`
  - `s3Probe(client: Sender, bucket: string): Probe`
  - `targetChecks(prefix: string, keys: string[]): TargetCheck[]`
  - `existingTargets(checks: TargetCheck[], probe: Probe): Promise<Set<string>>`
  - `existingLocal(destDir: string, rels: string[]): Set<string>`

- [ ] **Step 1: Tests schreiben**

`src/main/conflicts.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { existingLocal, existingTargets, s3Probe, targetChecks } from './conflicts'
import { fakeS3 } from './testing/fakeS3'

const many = (n: number, prefix = '') =>
  Array.from({ length: n }, (_, i) => ({ key: `${prefix}obj-${String(i).padStart(5, '0')}`, size: 1 }))

describe('conflict checks', () => {
  it('checks a single file with one HEAD, however large the bucket is', async () => {
    const s3 = fakeS3([...many(5000), { key: 'report.pdf', size: 1 }])

    const found = await existingTargets(targetChecks('', ['report.pdf']), s3Probe(s3, 'b'))

    expect([...found]).toEqual(['report.pdf'])
    expect(s3.requests.map((r) => r.command)).toEqual(['head'])
  })

  it('lists only the prefix of a selected folder', async () => {
    const s3 = fakeS3([{ key: 'photos/a.jpg', size: 1 }, ...many(3000, 'other/')])

    const found = await existingTargets(targetChecks('', ['photos/a.jpg', 'photos/b.jpg']), s3Probe(s3, 'b'))

    expect([...found]).toEqual(['photos/a.jpg'])
    expect(s3.requests).toEqual([{ command: 'list', input: expect.objectContaining({ Prefix: 'photos/' }) }])
  })

  it('groups keys under the folder they land in below the target', () => {
    expect(targetChecks('dest/', ['dest/a.txt', 'dest/up/x', 'dest/up/y', 'dest/up/deep/z'])).toEqual([
      { head: 'dest/a.txt' },
      { list: 'dest/up/', keys: ['dest/up/x', 'dest/up/y', 'dest/up/deep/z'] }
    ])
  })

  it('does not count a HEAD refused with 403 as a conflict', async () => {
    const s3 = fakeS3([{ key: 'report.pdf', size: 1 }], { headStatus: 403 })

    const found = await existingTargets([{ head: 'report.pdf' }], s3Probe(s3, 'b'))

    expect(found.size).toBe(0)
  })

  it('does not hide other failures', async () => {
    const s3 = fakeS3([], { headStatus: 500 })

    await expect(existingTargets([{ head: 'x' }], s3Probe(s3, 'b'))).rejects.toThrow()
  })

  it('finds downloads that already exist locally and leaves unsafe keys to fail later', () => {
    const dest = mkdtempSync(join(tmpdir(), 's3b-'))
    mkdirSync(join(dest, 'photos'))
    writeFileSync(join(dest, 'photos', 'a.jpg'), 'x')

    const found = existingLocal(dest, ['photos/a.jpg', 'photos/b.jpg', '../escape'])

    expect([...found]).toEqual(['photos/a.jpg'])
  })
})
```

- [ ] **Step 2: Fehlschlag prüfen**

Run: `npx vitest run src/main/conflicts.test.ts`
Expected: FAIL — `Failed to resolve import "./conflicts"`.

- [ ] **Step 3: Zielprüfung implementieren**

`src/main/conflicts.ts`:

```ts
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

export function s3Probe(client: Sender, bucket: string): Probe {
  return {
    async head(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
        return true
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
        // 404: not there. 403: what S3 answers for a missing key when the caller may not
        // list the bucket — typical for upload-only credentials — so it is no conflict either
        if (status === 404 || status === 403) return false
        throw err
      }
    },
    async list(prefix, wanted) {
      const found: string[] = []
      let token: string | undefined
      do {
        const res = (await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token })
        )) as ListObjectsV2CommandOutput
        for (const o of res.Contents ?? []) if (o.Key && wanted.has(o.Key)) found.push(o.Key)
        token = res.IsTruncated ? res.NextContinuationToken : undefined
      } while (token)
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
```

- [ ] **Step 4: Tests laufen lassen**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Mutationsprüfung**

- In `targetChecks` den `head`-Zweig entfernen (alles als Ordner behandeln) → „checks a single file with one HEAD…" scheitert.
- In `s3Probe.head` `|| status === 403` entfernen → „does not count a HEAD refused with 403…" scheitert.
- In `existingLocal` das `try { path = localPathFor… } catch { continue }` durch direkten Aufruf ersetzen → Download-Test scheitert (wirft).

- [ ] **Step 6: Commit**

```bash
git add src/main/conflicts.ts src/main/conflicts.test.ts
git commit -m "Check transfer targets with HEADs and folder listings instead of whole prefixes"
```

---

### Task 9: Konfliktabfragen für Upload und Download, Nachprüfung, README

**Files:**
- Modify: `src/main/jobFactory.ts`, `src/main/jobFactory.test.ts`
- Modify: `README.md`
- Verification (nicht committet): Ergänzungen in `<scratchpad>/e2e/queue.cjs`

**Interfaces:**
- Consumes: `existingTargets`, `existingLocal`, `s3Probe`, `targetChecks` (Task 8); `JobFactory.recheck` (Task 7).
- Produces: `createJobFactory(…)` liefert Konflikte für Upload, Download und Copy über die gezielte Prüfung und implementiert `recheck`. `UploadSpec` bekommt das Feld `prefix`.

- [ ] **Step 1: Tests schreiben**

In `src/main/jobFactory.test.ts` Importe ergänzen:

```ts
import { mkdirSync } from 'node:fs'
import { fakeS3 } from './testing/fakeS3'
```

und am Ende des `describe` anhängen:

```ts
  it('finds upload targets that already exist without listing the folder', async () => {
    const s3 = fakeS3([{ key: 'p/a.txt', size: 2 }])
    const dir = mkdtempSync(join(tmpdir(), 's3b-'))
    writeFileSync(join(dir, 'a.txt'), 'aa')
    writeFileSync(join(dir, 'b.txt'), 'bb')
    const withS3 = createJobFactory({
      getClient: () => s3 as unknown as S3Client,
      accountExists: () => true,
      listKeys: async () => []
    })

    const planned = await withS3.plan({
      kind: 'upload',
      accountId: 'acc',
      bucket: 'b',
      prefix: 'p/',
      paths: [join(dir, 'a.txt'), join(dir, 'b.txt')]
    })

    expect(planned.conflicts).toEqual([0])
    expect(planned.sample).toEqual(['p/a.txt'])
    expect(s3.requests.map((r) => r.command)).toEqual(['head', 'head'])
  })

  it('finds download targets that already exist in the chosen folder', async () => {
    const dest = mkdtempSync(join(tmpdir(), 's3b-'))
    mkdirSync(join(dest, 'k'))
    writeFileSync(join(dest, 'x.jpg'), 'x')

    const planned = await factory().plan({
      kind: 'download',
      accountId: 'acc',
      bucket: 'b',
      entries: [
        { key: 'k/x.jpg', type: 'file', size: 1 },
        { key: 'k/y.jpg', type: 'file', size: 1 }
      ],
      destDir: dest
    })

    expect(planned.conflicts).toEqual([0])
    expect(planned.sample).toEqual(['x.jpg'])
  })

  it('checks a copy of one file into a large bucket with a single HEAD', async () => {
    const big = Array.from({ length: 3000 }, (_, i) => ({ key: `obj-${i}`, size: 1 }))
    const s3 = fakeS3(big)
    const withS3 = createJobFactory({
      getClient: () => s3 as unknown as S3Client,
      accountExists: () => true,
      listKeys: async () => []
    })

    await withS3.plan({
      kind: 'copy',
      accountId: 'acc',
      bucket: 'src',
      entries: [{ key: 'docs/report.pdf', type: 'file', size: 1 }],
      target: { accountId: 'acc', bucket: 'b', prefix: '' }
    })

    expect(s3.requests.map((r) => r.command)).toEqual(['head'])
  })

  it('checks the targets of remaining upload items again', async () => {
    const s3 = fakeS3([{ key: 'p/b.txt', size: 2 }])
    const withS3 = createJobFactory({
      getClient: () => s3 as unknown as S3Client,
      accountExists: () => true,
      listKeys: async () => []
    })

    const exists = await withS3.recheck!('upload', { accountId: 'acc', bucket: 'b', prefix: 'p/' }, [
      { index: 4, name: 'a.txt', size: 2, data: { file: '/a.txt', key: 'p/a.txt' } },
      { index: 5, name: 'b.txt', size: 2, data: { file: '/b.txt', key: 'p/b.txt' } }
    ])

    expect(exists).toEqual([5])
  })
```

- [ ] **Step 2: Fehlschlag prüfen**

Run: `npx vitest run src/main/jobFactory.test.ts`
Expected: FAIL — Upload/Download melden `conflicts: []`, die Kopie listet statt `HEAD`, `recheck` ist `undefined`.

- [ ] **Step 3: Fabrik umstellen**

In `src/main/jobFactory.ts`:

1. Import ergänzen:

```ts
import { existingLocal, existingTargets, s3Probe, targetChecks } from './conflicts'
```

2. `UploadSpec` erweitern:

```ts
interface UploadSpec {
  accountId: string
  bucket: string
  /** target folder; jobs saved before it existed read as the bucket root */
  prefix?: string
}
```

3. Im `case 'upload':` von `plan` die Konflikte berechnen — den Block ersetzen durch:

```ts
        case 'upload': {
          const items = buildUploadItems(req.prefix, req.paths)
          const existing = await existingTargets(
            targetChecks(req.prefix, items.map((i) => i.data.key)),
            s3Probe(client(req.accountId), req.bucket)
          )
          const clashing = items.filter((i) => existing.has(i.data.key))
          const spec: UploadSpec = { accountId: req.accountId, bucket: req.bucket, prefix: req.prefix }
          return {
            kind: 'upload',
            title: `Upload ${count(items.length, 'file')} → ${at(req.bucket, req.prefix)}`,
            target: { type: 's3', accountId: req.accountId, bucket: req.bucket, prefix: req.prefix },
            items,
            conflicts: clashing.map((i) => i.index),
            sample: clashing.slice(0, 5).map((i) => i.data.key),
            spec
          }
        }
```

4. Im `case 'download':` nach `const items = …` einfügen und die Rückgabe anpassen:

```ts
          const existing = existingLocal(req.destDir, items.map((i) => i.data.rel))
          const clashing = items.filter((i) => existing.has(i.data.rel))
```

sowie `conflicts: clashing.map((i) => i.index)` und `sample: clashing.slice(0, 5).map((i) => i.data.rel)`.

5. Im `case 'copy':` die Zeilen ab `// today's check, narrowed …` bis `const clashing = …` ersetzen durch:

```ts
          const existing = await existingTargets(
            targetChecks(req.target.prefix, items.map((i) => i.data.targetKey)),
            s3Probe(client(req.target.accountId), req.target.bucket)
          )
          const clashing = items.filter((i) => existing.has(i.data.targetKey))
```

6. Nach der Methode `runtime(…)` im zurückgegebenen Objekt ergänzen:

```ts
    async recheck(kind, spec, items): Promise<number[]> {
      switch (kind) {
        case 'upload': {
          const s = spec as UploadSpec
          const typed = items as QueueItem<UploadData>[]
          const existing = await existingTargets(
            targetChecks(s.prefix ?? '', typed.map((i) => i.data.key)),
            s3Probe(client(s.accountId), s.bucket)
          )
          return typed.filter((i) => existing.has(i.data.key)).map((i) => i.index)
        }
        case 'download': {
          const s = spec as DownloadSpec
          const typed = items as QueueItem<DownloadData>[]
          const existing = existingLocal(s.destDir, typed.map((i) => i.data.rel))
          return typed.filter((i) => existing.has(i.data.rel)).map((i) => i.index)
        }
        case 'copy': {
          const s = spec as CopySpec
          const typed = items as QueueItem<CopyData>[]
          const existing = await existingTargets(
            targetChecks(s.target.prefix, typed.map((i) => i.data.targetKey)),
            s3Probe(client(s.target.accountId), s.target.bucket)
          )
          return typed.filter((i) => existing.has(i.data.targetKey)).map((i) => i.index)
        }
        case 'sync':
          // a sync decides per object while it runs
          return []
      }
    }
```

7. `listKeys` wird in `plan` für `copy` nicht mehr gebraucht; es bleibt für die Builder und den Sync.

- [ ] **Step 4: Tests laufen lassen**

Run: `npm test && npm run typecheck`
Expected: PASS für alle Testdateien.

- [ ] **Step 5: README ergänzen**

In `README.md`:

1. Im Abschnitt **Features → Transfers** die Zeile `- Live progress per item, cancel while running, clear finished` ersetzen durch:

```markdown
- A transfer queue: every upload, download and copy is one job listing its waiting
  files; at most four files move at once, and jobs take turns so a small one never
  waits behind a large one
- Pause everything or a single job — running files finish, nothing new starts — and
  cancel a job or a single running file
- Unfinished jobs survive quitting the app and are offered again on the next start
- Uploads, downloads and copies ask once per job when targets already exist:
  skip them or overwrite them
```

2. Im Abschnitt **Security** nach dem Punkt „Confined downloads." einfügen:

```markdown
- **Transfer queue on disk.** Unfinished jobs are kept under `userData/queue/`, readable
  only by you, with connection ids but never credentials. Download paths are derived
  again through the same confinement on every run instead of trusting a saved path.
```

3. Im Abschnitt **Project layout** den Eintrag `transfers.ts    upload/download/copy queue with progress events` ersetzen durch:

```
│   ├── transferQueue.ts  scheduler: four slots, fair turns, pause and cancel
│   ├── transferItems.ts  what a job is made of, and how one file moves
│   ├── syncSource.ts     a bucket sync, listed page by page with a resume mark
│   ├── queueService.ts   plans, jobs, persistence and restore, wired together
│   ├── queueStore.ts     job files and append-only logs under userData/queue
│   ├── conflicts.ts      which targets already exist, checked narrowly
│   ├── jobFactory.ts     turns a request into a runnable job
│   └── prefixScan.ts     background count of a folder's objects and bytes
```

- [ ] **Step 6: Ende-zu-Ende ergänzen (nicht committet)**

In `<scratchpad>/e2e/queue.cjs` vor `check('no renderer errors', …)` einfügen:

```js
  // 7) re-uploading the same files: every one is a conflict, found with HEADs only
  const before = s3.log.length
  const reupload = await win.evaluate(({ accountId, paths }) => window.api.queue.plan({ kind: 'upload', accountId, bucket: 'demo', prefix: 'up/', paths }), { accountId, paths })
  const planRequests = s3.log.slice(before)
  check('re-upload sees 30 conflicts', reupload.conflicts === 30, JSON.stringify(reupload))
  check('conflict check uses HEADs, not a listing', planRequests.every((r) => r.method === 'HEAD'), planRequests.map((r) => r.method).join(','))

  // 8) the conflict dialog through the real UI: copy the folder onto the earlier copy
  await win.locator('.crumb', { hasText: 'demo' }).click()
  await win.locator('tr', { hasText: 'up' }).first().locator('input[type="checkbox"]').check()
  await win.getByRole('button', { name: /Copy to/ }).click()
  const dialog = win.locator('.modal')
  await dialog.locator('select').nth(1).selectOption('demo')
  await dialog.locator('input[placeholder="e.g. backups/2026"]').fill('copy')
  await dialog.getByRole('button', { name: 'Copy', exact: true }).click()
  await win.getByText('Objects already exist').waitFor({ timeout: 10000 })
  check('conflict dialog lists the clash', await win.getByText('30 of 30 objects already exist').count() > 0)
  await win.getByRole('button', { name: 'Overwrite' }).click()
  await waitText(win, 'Copy 30 objects → demo/copy/')
```

Run: `npm run build && cd <scratchpad>/e2e && env -u ELECTRON_RUN_AS_NODE node queue.cjs && node restart.cjs`
Expected: jede Zeile `PASS`.

- [ ] **Step 7: Gesamtprüfung**

```bash
npm test
npm run build
grep -rn "transfer:\|shell:showItem\|window.api.transfers\|from './transfers'" src || echo "keine Altlasten"
```

Expected: alle Tests grün, Build grün, `keine Altlasten`. Falls in einem Task eine Abhängigkeit geändert wurde: `npx -y npm@10.9.9 ci --ignore-scripts` in einer sauberen Kopie von `package.json`, `package-lock.json`, `.npmrc`.

- [ ] **Step 8: Commit und Push von Etappe 3**

```bash
git add src/main/jobFactory.ts src/main/jobFactory.test.ts README.md
git commit -m "Ask once per job before uploads and downloads overwrite existing files"
git push origin main
```

Danach `gh run list --limit 1` bis zum Abschluss verfolgen: `npm test` und alle drei Plattform-Builds müssen grün sein.
