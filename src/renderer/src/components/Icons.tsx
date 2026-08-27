interface Props {
  size?: number
  className?: string
}

const base = (size: number): Record<string, string | number> => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
})

export const FolderIcon = ({ size = 15, className }: Props) => (
  <svg {...base(size)} className={`icon ${className ?? ''}`} style={{ color: 'var(--accent)' }}>
    <path d="M1.8 4.2h4l1.3 1.6h7.1v6.2a1 1 0 0 1-1 1H1.8a1 1 0 0 1-1-1V5.2a1 1 0 0 1 1-1Z" />
  </svg>
)

export const FileIcon = ({ size = 15, className }: Props) => (
  <svg {...base(size)} className={`icon ${className ?? ''}`} style={{ color: 'var(--text-faint)' }}>
    <path d="M9.2 1.6H4.4a1 1 0 0 0-1 1v10.8a1 1 0 0 0 1 1h7.2a1 1 0 0 0 1-1V5l-3.4-3.4Z" />
    <path d="M9.2 1.6V5h3.4" />
  </svg>
)

export const BucketIcon = ({ size = 15, className }: Props) => (
  <svg {...base(size)} className={`icon ${className ?? ''}`}>
    <path d="M2 3.4h12l-1.2 10.2a1 1 0 0 1-1 .8H4.2a1 1 0 0 1-1-.8L2 3.4Z" />
    <path d="M2.6 7h10.8" />
  </svg>
)

export const ServerIcon = ({ size = 15, className }: Props) => (
  <svg {...base(size)} className={`icon ${className ?? ''}`}>
    <rect x="1.8" y="2.4" width="12.4" height="4.4" rx="1" />
    <rect x="1.8" y="9.2" width="12.4" height="4.4" rx="1" />
    <path d="M4.4 4.6h.01M4.4 11.4h.01" />
  </svg>
)

export const UploadIcon = ({ size = 14, className }: Props) => (
  <svg {...base(size)} className={`icon ${className ?? ''}`}>
    <path d="M8 10.6V2.4M4.8 5.6 8 2.4l3.2 3.2" />
    <path d="M2 10.6v2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2" />
  </svg>
)

export const DownloadIcon = ({ size = 14, className }: Props) => (
  <svg {...base(size)} className={`icon ${className ?? ''}`}>
    <path d="M8 2.4v8.2M4.8 7.4 8 10.6l3.2-3.2" />
    <path d="M2 10.6v2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2" />
  </svg>
)

export const TrashIcon = ({ size = 14, className }: Props) => (
  <svg {...base(size)} className={`icon ${className ?? ''}`}>
    <path d="M2.6 4.2h10.8M6 4.2V2.8a.8.8 0 0 1 .8-.8h2.4a.8.8 0 0 1 .8.8v1.4" />
    <path d="M12.2 4.2v8.6a1 1 0 0 1-1 1H4.8a1 1 0 0 1-1-1V4.2" />
  </svg>
)

export const RefreshIcon = ({ size = 14, className }: Props) => (
  <svg {...base(size)} className={`icon ${className ?? ''}`}>
    <path d="M13.6 6.8A5.7 5.7 0 0 0 3.4 4.8M2.4 9.2a5.7 5.7 0 0 0 10.2 2" />
    <path d="M13.6 2.6v4.2H9.4M2.4 13.4V9.2h4.2" />
  </svg>
)

export const PlusIcon = ({ size = 14, className }: Props) => (
  <svg {...base(size)} className={`icon ${className ?? ''}`}>
    <path d="M8 3.2v9.6M3.2 8h9.6" />
  </svg>
)

export const NewFolderIcon = ({ size = 14, className }: Props) => (
  <svg {...base(size)} className={`icon ${className ?? ''}`}>
    <path d="M14.2 8.4V5.8H7.1L5.8 4.2h-4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h6" />
    <path d="M11.6 10v4.2M9.5 12.1h4.2" />
  </svg>
)

export const LinkIcon = ({ size = 14, className }: Props) => (
  <svg {...base(size)} className={`icon ${className ?? ''}`}>
    <path d="M6.6 9.4a2.6 2.6 0 0 0 3.9.3l2-2a2.6 2.6 0 0 0-3.7-3.7l-1.1 1.1" />
    <path d="M9.4 6.6a2.6 2.6 0 0 0-3.9-.3l-2 2a2.6 2.6 0 0 0 3.7 3.7l1.1-1.1" />
  </svg>
)

export const PencilIcon = ({ size = 14, className }: Props) => (
  <svg {...base(size)} className={`icon ${className ?? ''}`}>
    <path d="M11.2 2.4a1.6 1.6 0 0 1 2.3 2.3L5.2 13 2 14l1-3.2 8.2-8.4Z" />
  </svg>
)

export const InfoIcon = ({ size = 14, className }: Props) => (
  <svg {...base(size)} className={`icon ${className ?? ''}`}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M8 7.4v3.6M8 5.2h.01" />
  </svg>
)

export const CopyIcon = ({ size = 14, className }: Props) => (
  <svg {...base(size)} className={`icon ${className ?? ''}`}>
    <rect x="5.6" y="5.6" width="8" height="8" rx="1" />
    <path d="M10.4 5.6V3.4a1 1 0 0 0-1-1H3.4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.2" />
  </svg>
)

export const XIcon = ({ size = 13, className }: Props) => (
  <svg {...base(size)} className={`icon ${className ?? ''}`}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
)

export const ChevronIcon = ({ size = 13, className }: Props) => (
  <svg {...base(size)} className={`icon ${className ?? ''}`}>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </svg>
)
