import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Account, AccountInput } from '@shared/types'

interface StoredAccount extends Account {
  /** base64 of safeStorage-encrypted secret, or plain text when encryption is unavailable */
  secret: string
  encrypted: boolean
}

interface StoreShape {
  version: 1
  accounts: StoredAccount[]
}

const EMPTY: StoreShape = { version: 1, accounts: [] }

function configDir(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function configPath(): string {
  return join(configDir(), 'accounts.json')
}

function read(): StoreShape {
  const file = configPath()
  if (!existsSync(file)) return { ...EMPTY, accounts: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoreShape
    if (!parsed || !Array.isArray(parsed.accounts)) return { ...EMPTY, accounts: [] }
    return parsed
  } catch {
    return { ...EMPTY, accounts: [] }
  }
}

function write(data: StoreShape): void {
  const file = configPath()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
}

function encryptSecret(secret: string): { secret: string; encrypted: boolean } {
  if (safeStorage.isEncryptionAvailable()) {
    return { secret: safeStorage.encryptString(secret).toString('base64'), encrypted: true }
  }
  return { secret, encrypted: false }
}

function decryptSecret(stored: StoredAccount): string {
  if (!stored.encrypted) return stored.secret
  try {
    return safeStorage.decryptString(Buffer.from(stored.secret, 'base64'))
  } catch {
    return ''
  }
}

function strip(a: StoredAccount): Account {
  const { secret: _secret, encrypted: _encrypted, ...rest } = a
  return rest
}

export function listAccounts(): Account[] {
  return read().accounts.map(strip)
}

export function getAccount(id: string): Account | undefined {
  const found = read().accounts.find((a) => a.id === id)
  return found ? strip(found) : undefined
}

export function getCredentials(id: string): { accessKeyId: string; secretAccessKey: string } | undefined {
  const found = read().accounts.find((a) => a.id === id)
  if (!found) return undefined
  return { accessKeyId: found.accessKeyId, secretAccessKey: decryptSecret(found) }
}

export function saveAccount(input: AccountInput): Account {
  const data = read()
  const now = Date.now()
  const id = input.id ?? randomUUID()
  const existing = data.accounts.find((a) => a.id === id)

  let secretFields: { secret: string; encrypted: boolean }
  if (input.secretAccessKey) {
    // secrets pasted from files or web consoles often carry stray whitespace,
    // which breaks request signing with a misleading SignatureDoesNotMatch
    secretFields = encryptSecret(input.secretAccessKey.trim())
  } else if (existing) {
    secretFields = { secret: existing.secret, encrypted: existing.encrypted }
  } else {
    secretFields = encryptSecret('')
  }

  const account: StoredAccount = {
    id,
    name: input.name.trim() || 'Unnamed connection',
    provider: input.provider,
    endpoint: input.endpoint.trim(),
    region: input.region.trim() || 'us-east-1',
    accessKeyId: input.accessKeyId.trim(),
    forcePathStyle: !!input.forcePathStyle,
    allowInsecureTls: !!input.allowInsecureTls,
    createdAt: existing?.createdAt ?? now,
    ...secretFields
  }

  data.accounts = existing
    ? data.accounts.map((a) => (a.id === id ? account : a))
    : [...data.accounts, account]

  write(data)
  return strip(account)
}

export function deleteAccount(id: string): void {
  const data = read()
  data.accounts = data.accounts.filter((a) => a.id !== id)
  write(data)
}

export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}
