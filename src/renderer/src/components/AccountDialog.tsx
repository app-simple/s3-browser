import { useEffect, useMemo, useState } from 'react'
import type { Account, AccountInput, ProviderId } from '@shared/types'
import { PROVIDERS, getProvider, buildEndpoint } from '@shared/providers'

interface Props {
  account: Account | null
  onClose: () => void
  onSaved: (account: Account) => void
}

export default function AccountDialog({ account, onClose, onSaved }: Props) {
  const isEdit = !!account
  const [name, setName] = useState(account?.name ?? '')
  const [provider, setProvider] = useState<ProviderId>(account?.provider ?? 'aws')
  const [region, setRegion] = useState(account?.region ?? 'eu-central-1')
  const [endpoint, setEndpoint] = useState(account?.endpoint ?? '')
  const [accessKeyId, setAccessKeyId] = useState(account?.accessKeyId ?? '')
  const [secret, setSecret] = useState('')
  const [pathStyle, setPathStyle] = useState(account?.forcePathStyle ?? false)
  const [insecure, setInsecure] = useState(account?.allowInsecureTls ?? false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)
  // null while unknown; false means the secret would land in accounts.json unprotected
  const [keychain, setKeychain] = useState<boolean | null>(null)

  const preset = useMemo(() => getProvider(provider), [provider])

  useEffect(() => {
    window.api.accounts
      .encryptionAvailable()
      .then(setKeychain)
      .catch(() => setKeychain(false))
  }, [])

  const plainHttp = provider !== 'aws' && /^http:\/\//i.test(endpoint.trim())

  // when the provider changes (but not on initial edit render) apply its defaults
  useEffect(() => {
    if (isEdit && provider === account?.provider) return
    setRegion(preset.defaultRegion)
    setEndpoint(buildEndpoint(preset.id, preset.defaultRegion))
    setPathStyle(preset.forcePathStyle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider])

  function onRegionChange(next: string): void {
    setRegion(next)
    if (!preset.customEndpoint) setEndpoint(buildEndpoint(preset.id, next))
  }

  function buildInput(): AccountInput {
    return {
      id: account?.id,
      name: name.trim() || preset.label,
      provider,
      endpoint: provider === 'aws' ? '' : endpoint.trim(),
      region: region.trim(),
      accessKeyId: accessKeyId.trim(),
      forcePathStyle: pathStyle,
      allowInsecureTls: insecure,
      secretAccessKey: secret || undefined
    }
  }

  const canSave = accessKeyId.trim().length > 0 && (isEdit || secret.length > 0)

  async function save(): Promise<Account | null> {
    setError(null)
    setBusy(true)
    try {
      return await window.api.accounts.save(buildInput())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setBusy(false)
    }
  }

  async function handleTest(): Promise<void> {
    setTestResult(null)
    setError(null)
    setBusy(true)
    try {
      // tests the current form values with a transient client — nothing is saved
      setTestResult(await window.api.accounts.test(buildInput()))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleSave(): Promise<void> {
    const saved = await save()
    if (saved) onSaved(saved)
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">{isEdit ? 'Edit connection' : 'New connection'}</div>
        <div className="modal-body">
          <div className="field">
            <label>Provider</label>
            <select value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
            {preset.hint && <div className="hint">{preset.hint}</div>}
          </div>

          <div className="field">
            <label>Display name</label>
            <input
              value={name}
              placeholder={preset.label}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="field field-row">
            <div>
              <label>Region</label>
              {preset.regions.length > 1 && !preset.customEndpoint ? (
                <select value={region} onChange={(e) => onRegionChange(e.target.value)}>
                  {preset.regions.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              ) : (
                <input value={region} onChange={(e) => onRegionChange(e.target.value)} />
              )}
            </div>
            {provider !== 'aws' && (
              <div>
                <label>Endpoint</label>
                <input
                  value={endpoint}
                  spellCheck={false}
                  onChange={(e) => setEndpoint(e.target.value)}
                />
              </div>
            )}
          </div>
          {plainHttp && (
            <div className="hint warn">
              Plain HTTP: object data and listings travel unencrypted. Only use this for a local
              or trusted network.
            </div>
          )}

          <div className="field">
            <label>Access key ID</label>
            <input
              value={accessKeyId}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setAccessKeyId(e.target.value)}
            />
          </div>

          <div className="field">
            <label>Secret access key</label>
            <input
              type="password"
              value={secret}
              spellCheck={false}
              autoComplete="off"
              placeholder={isEdit ? 'unchanged — type to replace' : ''}
              onChange={(e) => setSecret(e.target.value)}
            />
            {keychain === false ? (
              <div className="hint warn">
                No OS keychain protection is available on this system — the secret would be
                saved in the app's config file without strong encryption. On Linux, unlock or
                install a keyring (GNOME Keyring / KWallet) and restart the app.
              </div>
            ) : (
              <div className="hint">
                Stored encrypted in your OS keychain (Keychain / DPAPI / libsecret) and never
                leaves this machine.
              </div>
            )}
          </div>

          <div className="field">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={pathStyle}
                onChange={(e) => setPathStyle(e.target.checked)}
              />
              Force path-style addressing
            </label>
            <label className="checkbox" style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                checked={insecure}
                onChange={(e) => setInsecure(e.target.checked)}
              />
              Allow self-signed TLS certificates
            </label>
            {insecure && (
              <div className="hint warn">
                Disables all certificate checks for this connection, not just self-signed ones —
                anyone on the network path could impersonate the server.
              </div>
            )}
          </div>

          {error && <div className="banner error" style={{ margin: '0 0 12px' }}>{error}</div>}
          {testResult && (
            <div className="banner info" style={{ margin: '0 0 12px' }}>{testResult}</div>
          )}
        </div>

        <div className="modal-foot">
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button onClick={handleTest} disabled={busy || !canSave}>
            {busy ? <span className="spinner" /> : null} Test
          </button>
          <button className="primary" onClick={handleSave} disabled={busy || !canSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
