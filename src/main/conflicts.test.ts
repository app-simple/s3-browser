import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { existingLocal, existingTargets, s3Probe, targetChecks } from './conflicts'
import { fakeS3, httpError } from './testing/fakeS3'

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

  it('treats a folder the credentials may not list as having no known conflicts', async () => {
    const s3 = fakeS3([{ key: 'photos/a.jpg', size: 1 }], {
      failWith: httpError(403, 'AccessDenied', 'Access Denied')
    })

    const found = await existingTargets(targetChecks('', ['photos/a.jpg', 'photos/b.jpg']), s3Probe(s3, 'b'))

    expect(found.size).toBe(0)
  })
})
