'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'
import {
  DownloadIcon,
  Trash2Icon,
} from 'lucide-react'
import type { Split } from '@/lib/schema'
import { assignFileSplit } from '@/app/actions/files'

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif'])
const VIDEO_EXTS = new Set(['mp4', 'mov'])

function isImage(key: string): boolean {
  const ext = key.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTS.has(ext)
}

function isVideo(key: string): boolean {
  const ext = key.split('.').pop()?.toLowerCase() ?? ''
  return VIDEO_EXTS.has(ext)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** Thumbnail URL — served by our API, cached by ETag (content hash from S3) */
function thumbnailUrl(key: string, etag: string, size: number): string {
  return `/api/files/thumbnail?key=${encodeURIComponent(key)}&etag=${encodeURIComponent(etag)}&size=${size}`
}

interface FileEntry {
  key: string
  size: number
  lastModifiedIso: string
  etag: string
  split: Split | null
}

// Split badge helpers removed

interface Props {
  files: FileEntry[]
  timezone: string
  canWrite?: boolean
  onImageClick?: (file: FileEntry) => void
}

export default function FileLightbox({ files: initialFiles, timezone, canWrite = false, onImageClick }: Props) {
  const router = useRouter()
  const [files, setFiles] = useState(initialFiles)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dlLoading, setDlLoading] = useState(false)
  const [bulkWorking, setBulkWorking] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<{ keys: string[]; label: string } | null>(null)

  // Keep files in sync if parent re-renders (after router.refresh)
  useEffect(() => { setFiles(initialFiles) }, [initialFiles])

  // ---- Selection ----
  const toggleSelect = useCallback((key: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setSelected(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }, [])

  const allSelected = files.length > 0 && selected.size === files.length
  const toggleSelectAll = () => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(files.map(f => f.key)))
  }

  // ---- Delete ----
  const deleteKeys = useCallback(async (keys: string[]) => {
    // Optimistic remove
    setFiles(prev => prev.filter(f => !keys.includes(f.key)))
    setSelected(prev => { const n = new Set(prev); keys.forEach(k => n.delete(k)); return n })
    await Promise.all(keys.map(k =>
      fetch(`/api/files?key=${encodeURIComponent(k)}`, { method: 'DELETE' })
    ))
    router.refresh()
  }, [router])

  const deleteSelected = async () => {
    if (!selected.size) return
    setDeleteConfirm({
      keys: [...selected],
      label: `${selected.size} file${selected.size !== 1 ? 's' : ''}`,
    })
  }

  const deleteSingle = (key: string) => {
    const name = key.split('/').pop() ?? key
    setDeleteConfirm({ keys: [key], label: name })
  }

  const confirmDelete = async () => {
    if (!deleteConfirm) return
    const { keys } = deleteConfirm
    setDeleteConfirm(null)
    if (keys.length > 1) setBulkWorking(true)
    try { await deleteKeys(keys) } finally { setBulkWorking(false) }
  }

  // Split dialog handlers removed

  // ---- Download (single) ----
  const downloadSingle = useCallback(async (key: string) => {
    setDlLoading(true)
    try {
      const res = await fetch(`/api/files/presign?key=${encodeURIComponent(key)}&download=1`)
      if (!res.ok) return
      const { url } = await res.json() as { url: string }
      window.location.href = url
    } finally {
      setDlLoading(false)
    }
  }, [])

  // ---- Bulk download ----
  const downloadKeys = async (keys: string[]) => {
    setBulkWorking(true)
    try {
      for (const key of keys) {
        const res = await fetch(`/api/files/presign?key=${encodeURIComponent(key)}&download=1`)
        if (!res.ok) continue
        const { url } = await res.json() as { url: string }
        window.location.href = url
        await new Promise(r => setTimeout(r, 500))
      }
    } finally {
      setBulkWorking(false)
    }
  }

  const downloadSelected = () => downloadKeys(files.filter(f => selected.has(f.key)).map(f => f.key))

  const fmt = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  })

  // ---- Toolbar ----
  const toolbar = (
    <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 bg-gray-50 gap-3 flex-wrap">
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={toggleSelectAll}
          className="rounded"
          aria-label="Select all"
        />
        {selected.size > 0 ? (
          <span className="text-xs text-gray-600">{selected.size} selected</span>
        ) : (
          <span className="text-xs text-gray-400">{files.length} file{files.length !== 1 ? 's' : ''}</span>
        )}
        {selected.size > 0 && (
          <div className="flex items-center gap-2">
            <button
              onClick={downloadSelected}
              disabled={bulkWorking}
              className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), 'gap-1.5')}
            >
              <DownloadIcon className="w-3.5 h-3.5" />
              Download
            </button>
            {canWrite && (
              <button
                onClick={deleteSelected}
                disabled={bulkWorking}
                className={cn(buttonVariants({ variant: 'ghost', size: 'xs' }), 'gap-1.5 text-destructive hover:text-destructive')}
              >
                <Trash2Icon className="w-3.5 h-3.5" />
                Delete
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )

  // ---- List view ----
  const listView = (
    <table className="w-full text-sm">
      <thead className="bg-gray-50 border-b border-gray-200">
        <tr>
          <th className="w-10 px-4 py-3" />
          <th className="text-left px-4 py-3 font-medium text-gray-600">Filename</th>
          <th className="text-left px-4 py-3 font-medium text-gray-600">Size</th>
          <th className="text-left px-4 py-3 font-medium text-gray-600">Last modified</th>
          {canWrite && <th className="w-10 px-4 py-3" />}
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {files.map((file, i) => {
          const filename = file.key.split('/').pop() ?? file.key
          const img = isImage(file.key)
          const isSel = selected.has(file.key)
          return (
            <tr
              key={file.key}
              className={cn('transition-colors', isSel ? 'bg-blue-50' : 'hover:bg-gray-50')}
            >
              <td className="px-4 py-3" onClick={e => toggleSelect(file.key, e)}>
                <input
                  type="checkbox"
                  checked={isSel}
                  onChange={() => {}}
                  className="rounded"
                />
              </td>
              <td
                className="px-4 py-3 font-mono text-xs text-blue-600 cursor-pointer"
                onClick={() => {
                  if ((isImage(file.key) || isVideo(file.key)) && onImageClick) {
                    onImageClick(file)
                  } else {
                    downloadSingle(file.key)
                  }
                }}
              >
                <div className="flex items-center gap-2">
                  {img ? (
                    <div className="w-8 h-8 rounded bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-500 shrink-0">
                      📸
                    </div>
                  ) : isVideo(file.key) ? (
                    <div className="w-8 h-8 rounded bg-slate-100 flex items-center justify-center text-slate-500 shrink-0">
                      🎥
                    </div>
                  ) : null}
                  <span className="hover:underline">{filename}</span>
                </div>
              </td>
              <td className="px-4 py-3 text-gray-500">{formatBytes(file.size)}</td>
              <td className="px-4 py-3 text-gray-500">{fmt.format(new Date(file.lastModifiedIso))}</td>
              {canWrite && (
                <td className="px-4 py-3">
                  <button
                    onClick={() => deleteSingle(file.key)}
                    className={cn(buttonVariants({ variant: 'ghost', size: 'xs' }), 'text-destructive hover:text-destructive')}
                    aria-label="Delete"
                  >
                    <Trash2Icon className="w-3.5 h-3.5" />
                  </button>
                </td>
              )}
            </tr>
          )
        })}
      </tbody>
    </table>
  )

  return (
    <>
      {toolbar}
      {listView}

      {/* Delete confirmation */}
      <Dialog open={!!deleteConfirm} onOpenChange={(o) => { if (!o) setDeleteConfirm(null) }}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Delete file{deleteConfirm?.keys.length !== 1 ? 's' : ''}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">
            Are you sure you want to delete <strong>{deleteConfirm?.label}</strong>? This cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
