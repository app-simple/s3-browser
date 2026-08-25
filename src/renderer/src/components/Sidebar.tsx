import { useState } from 'react'
import type { Account, BucketInfo } from '@shared/types'
import { BucketIcon, ServerIcon, PlusIcon, PencilIcon, RefreshIcon, ChevronIcon } from './Icons'

interface Props {
  accounts: Account[]
  buckets: Record<string, BucketInfo[]>
  loadingAccountId: string | null
  activeAccountId: string | null
  activeBucket: string | null
  isMac: boolean
  onSelectAccount: (id: string) => void
  onSelectBucket: (accountId: string, bucket: string) => void
  onAddAccount: () => void
  onEditAccount: (account: Account) => void
  onRefreshBuckets: (accountId: string) => void
  onNewBucket: (accountId: string) => void
}

export default function Sidebar({
  accounts,
  buckets,
  loadingAccountId,
  activeAccountId,
  activeBucket,
  isMac,
  onSelectAccount,
  onSelectBucket,
  onAddAccount,
  onEditAccount,
  onRefreshBuckets,
  onNewBucket
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  function toggle(id: string): void {
    setCollapsed((c) => ({ ...c, [id]: !c[id] }))
  }

  return (
    <aside className="sidebar">
      <div className={`sidebar-head ${isMac ? 'mac' : ''}`}>
        <span className="sidebar-title">Connections</span>
        <button className="ghost" title="New connection" onClick={onAddAccount}>
          <PlusIcon />
        </button>
      </div>

      <div className="sidebar-body">
        {accounts.length === 0 && (
          <div className="tree-empty">
            No connections yet.
            <br />
            Click + to add one.
          </div>
        )}

        {accounts.map((acc) => {
          const isOpen = !collapsed[acc.id]
          const list = buckets[acc.id]
          return (
            <div className="tree-group" key={acc.id}>
              <div
                className={`tree-item ${activeAccountId === acc.id && !activeBucket ? 'active' : ''}`}
                onClick={() => {
                  onSelectAccount(acc.id)
                  if (collapsed[acc.id]) toggle(acc.id)
                }}
              >
                <span
                  onClick={(e) => {
                    e.stopPropagation()
                    toggle(acc.id)
                  }}
                  style={{
                    display: 'flex',
                    transform: isOpen ? 'rotate(90deg)' : 'none',
                    transition: 'transform .12s',
                    color: 'var(--text-faint)'
                  }}
                >
                  <ChevronIcon />
                </span>
                <ServerIcon />
                <span className="name" title={acc.endpoint || 'AWS default endpoint'}>
                  {acc.name}
                </span>
                {loadingAccountId === acc.id && <span className="spinner" />}
                <button
                  className="ghost"
                  title="Edit connection"
                  onClick={(e) => {
                    e.stopPropagation()
                    onEditAccount(acc)
                  }}
                  style={{ padding: 2 }}
                >
                  <PencilIcon size={12} />
                </button>
              </div>

              {isOpen && (
                <div className="tree-children">
                  {list?.map((b) => (
                    <div
                      key={b.name}
                      className={`tree-item ${
                        activeAccountId === acc.id && activeBucket === b.name ? 'active' : ''
                      }`}
                      onClick={() => onSelectBucket(acc.id, b.name)}
                      title={b.name}
                    >
                      <BucketIcon size={13} />
                      <span className="name">{b.name}</span>
                    </div>
                  ))}
                  {list && list.length === 0 && <div className="tree-empty">No buckets</div>}
                  {list && (
                    <div style={{ display: 'flex', gap: 4, padding: '4px 6px' }}>
                      <button
                        className="ghost"
                        style={{ fontSize: 11.5, padding: '3px 6px' }}
                        onClick={() => onNewBucket(acc.id)}
                      >
                        <PlusIcon size={11} /> Bucket
                      </button>
                      <button
                        className="ghost"
                        style={{ fontSize: 11.5, padding: '3px 6px' }}
                        onClick={() => onRefreshBuckets(acc.id)}
                      >
                        <RefreshIcon size={11} />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="sidebar-foot">
        <button style={{ width: '100%', justifyContent: 'center' }} onClick={onAddAccount}>
          <PlusIcon /> Add connection
        </button>
      </div>
    </aside>
  )
}
