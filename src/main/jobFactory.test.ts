import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { S3Client } from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'
import { createJobFactory } from './jobFactory'
import { JobFailure } from './transferQueue'
import { mkdirSync } from 'node:fs'
import { fakeS3 } from './testing/fakeS3'

const factory = (accountExists = true) =>
  createJobFactory({
    // an empty bucket: planning an upload now asks S3 whether its targets exist
    getClient: () => fakeS3([]) as unknown as S3Client,
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
})
