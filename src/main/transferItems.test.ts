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
