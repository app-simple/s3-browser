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
