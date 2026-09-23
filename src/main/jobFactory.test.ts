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
