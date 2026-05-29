'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
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
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  Trash2Icon,
  LayoutGridIcon,
  ListIcon,
  TagIcon,
} from 'lucide-react'
import type { Split } from '@/lib/schema'
import { assignFileSplit } from '@/app/actions/files'

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif'])

function isImage(key: string): boolean {
  const ext = key.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTS.has(ext)
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

type SplitChoice = Split | 'none'

const SPLIT_STYLES: Record<Split, string> = {
  train: 'bg-blue-100 text-blue-700',
  val:   'bg-amber-100 text-amber-700',
  test:  'bg-green-100 text-green-700',
}

function splitSelectClass(split: Split | null): string {
  if (split === 'train') return 'bg-blue-50 border-blue-300 text-blue-700'
  if (split === 'val')   return 'bg-amber-50 border-amber-300 text-amber-700'
  if (split === 'test')  return 'bg-green-50 border-green-300 text-green-700'
  return 'bg-white border-gray-200 text-gray-400'
}

function SplitBadge({ split }: { split: Split | null }) {
  if (!split) return <span className="text-xs text-gray-300 select-none">—</span>
  return (
    <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium', SPLIT_STYLES[split])}>
      {split}
    </span>
  )
}

interface Props {
  files: FileEntry[]
  timezone: string
  canWrite?: boolean
}

export default function FileLightbox({ files: initialFiles, timezone, canWrite = false }: Props) {
  const router = useRouter()
  const [files, setFiles] = useState(initialFiles)
  const [view, setView] = useState<'list' | 'grid'>('list')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const lightboxIndexRef = useRef<number | null>(null)
  const [dlLoading, setDlLoading] = useState(false)
  const [bulkWorking, setBulkWorking] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<{ keys: string[]; label: string } | null>(null)

  // Split assignment state
  const [splits, setSplits] = useState<Map<string, Split | null>>(
    () => new Map(initialFiles.map(f => [f.key, f.split]))
  )
  const [splitDialog, setSplitDialog] = useState<{ keys: string[] } | null>(null)
  const [pendingSplit, setPendingSplit] = useState<SplitChoice | null>(null)

  const lightboxOpen = lightboxIndex !== null
  const activeFile = lightboxIndex !== null ? files[lightboxIndex] : null

  // Keep files in sync if parent re-renders (after router.refresh)
  useEffect(() => { setFiles(initialFiles) }, [initialFiles])
  useEffect(() => {
    setSplits(new Map(initialFiles.map(f => [f.key, f.split])))
  }, [initialFiles])

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

  // ---- Lightbox nav ----
  const goTo = useCallback((index: number) => {
    const clamped = (index + files.length) % files.length
    lightboxIndexRef.current = clamped
    setLightboxIndex(clamped)
  }, [files])

  const openFile = useCallback((i: number) => {
    lightboxIndexRef.current = i
    setLightboxIndex(i)
  }, [])

  const closeLightbox = useCallback(() => {
    lightboxIndexRef.current = null
    setLightboxIndex(null)
  }, [])

  // Arrow keys — capture phase
  useEffect(() => {
    if (!lightboxOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.stopPropagation()
      const cur = lightboxIndexRef.current ?? 0
      goTo(e.key === 'ArrowLeft' ? cur - 1 : cur + 1)
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [lightboxOpen, goTo])

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
    closeLightbox()
    if (keys.length > 1) setBulkWorking(true)
    try { await deleteKeys(keys) } finally { setBulkWorking(false) }
  }

  const openSplitDialog = (keys: string[]) => {
    setSplitDialog({ keys })
    setPendingSplit(null)
  }

  const handleSplitChange = useCallback(async (key: string, choice: SplitChoice) => {
    const cur = splits.get(key) ?? null
    const target = choice === 'none' ? null : choice as Split
    if (cur === target) return
    if (cur !== null && target !== null) {
      // Reassignment: pre-fill dialog so user can confirm
      setSplitDialog({ keys: [key] })
      setPendingSplit(choice)
      return
    }
    // Direct assign or clear: apply immediately
    setSplits(prev => { const n = new Map(prev); n.set(key, target); return n })
    await assignFileSplit(key, target)
    router.refresh()
  }, [splits, router])

  const confirmSplitAssign = useCallback(async () => {
    if (!splitDialog || pendingSplit === null) return
    const target = pendingSplit === 'none' ? null : pendingSplit
    const keys = splitDialog.keys
    setSplitDialog(null)
    setPendingSplit(null)
    setSplits(prev => {
      const next = new Map(prev)
      for (const k of keys) next.set(k, target)
      return next
    })
    await Promise.all(keys.map(k => assignFileSplit(k, target)))
    router.refresh()
  }, [splitDialog, pendingSplit, router])

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
              <>
                <button
                  onClick={() => openSplitDialog([...selected])}
                  disabled={bulkWorking}
                  className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), 'gap-1.5')}
                >
                  <TagIcon className="w-3.5 h-3.5" />
                  Assign split
                </button>
                <button
                  onClick={deleteSelected}
                  disabled={bulkWorking}
                  className={cn(buttonVariants({ variant: 'ghost', size: 'xs' }), 'gap-1.5 text-destructive hover:text-destructive')}
                >
                  <Trash2Icon className="w-3.5 h-3.5" />
                  Delete
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={() => setView('list')}
          className={cn(buttonVariants({ variant: view === 'list' ? 'secondary' : 'ghost', size: 'xs' }))}
          aria-label="List view"
        >
          <ListIcon className="w-4 h-4" />
        </button>
        <button
          onClick={() => setView('grid')}
          className={cn(buttonVariants({ variant: view === 'grid' ? 'secondary' : 'ghost', size: 'xs' }))}
          aria-label="Grid view"
        >
          <LayoutGridIcon className="w-4 h-4" />
        </button>
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
          <th className="text-left px-4 py-3 font-medium text-gray-600">Split</th>
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
                onClick={() => isImage(file.key) ? openFile(i) : downloadSingle(file.key)}
              >
                <div className="flex items-center gap-2">
                  {img && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={thumbnailUrl(file.key, file.etag, 64)}
                      alt=""
                      className="w-8 h-8 rounded object-cover bg-gray-100 shrink-0"
                    />
                  )}
                  <span className="hover:underline">{filename}</span>
                </div>
              </td>
              <td className="px-4 py-3 text-gray-500">{formatBytes(file.size)}</td>
              <td className="px-4 py-3 text-gray-500">{fmt.format(new Date(file.lastModifiedIso))}</td>
              <td className="px-4 py-3">
                {canWrite ? (
                  <select
                    value={splits.get(file.key) ?? 'none'}
                    onChange={e => handleSplitChange(file.key, e.target.value as SplitChoice)}
                    className={cn(
                      'text-xs rounded border px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400 cursor-pointer',
                      splitSelectClass(splits.get(file.key) ?? null),
                    )}
                  >
                    <option value="none">—</option>
                    <option value="train">train</option>
                    <option value="val">val</option>
                    <option value="test">test</option>
                  </select>
                ) : (
                  <SplitBadge split={splits.get(file.key) ?? null} />
                )}
              </td>
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

  // ---- Grid view ----
  const gridView = (
    <div className="p-4 grid grid-cols-3 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-2">
      {files.map((file, i) => {
        const filename = file.key.split('/').pop() ?? file.key
        const img = isImage(file.key)
        const isSel = selected.has(file.key)
        return (
          <div
            key={file.key}
            className={cn(
              'relative rounded-lg border overflow-hidden group cursor-pointer transition-colors',
              isSel ? 'border-blue-500 ring-2 ring-blue-300' : 'border-gray-200 hover:border-gray-400'
            )}
          >
            {/* Thumbnail / icon */}
            <div
              className="aspect-square bg-gray-100 flex items-center justify-center overflow-hidden"
              onClick={() => isImage(file.key) ? openFile(i) : downloadSingle(file.key)}
            >
              {img ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={thumbnailUrl(file.key, file.etag, 160)}
                  alt={filename}
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="text-2xl text-gray-400 font-mono uppercase text-xs">
                  {file.key.split('.').pop()}
                </span>
              )}
            </div>
            {/* Checkbox */}
            <div
              className="absolute top-2 left-2"
              onClick={e => toggleSelect(file.key, e)}
            >
              <input
                type="checkbox"
                checked={isSel}
                onChange={() => {}}
                className="rounded"
              />
            </div>
            {/* Delete button */}
            {canWrite && (
              <button
                onClick={e => { e.stopPropagation(); deleteSingle(file.key) }}
                className={cn(
                  buttonVariants({ variant: 'ghost', size: 'xs' }),
                  'absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-white/80 text-destructive hover:text-destructive'
                )}
                aria-label="Delete"
              >
                <Trash2Icon className="w-3.5 h-3.5" />
              </button>
            )}
            {/* Label */}
            <div className="p-2 border-t border-gray-100">
              <p className="text-xs font-mono text-gray-700 truncate" title={filename}>{filename}</p>
              <div className="flex items-center justify-between mt-0.5">
                <p className="text-xs text-gray-400">{formatBytes(file.size)}</p>
                {canWrite ? (
                  <select
                    value={splits.get(file.key) ?? 'none'}
                    onChange={e => { e.stopPropagation(); handleSplitChange(file.key, e.target.value as SplitChoice) }}
                    className={cn(
                      'text-xs rounded border px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400 cursor-pointer max-w-full',
                      splitSelectClass(splits.get(file.key) ?? null),
                    )}
                  >
                    <option value="none">—</option>
                    <option value="train">train</option>
                    <option value="val">val</option>
                    <option value="test">test</option>
                  </select>
                ) : (
                  <SplitBadge split={splits.get(file.key) ?? null} />
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )

  return (
    <>
      {toolbar}
      {view === 'list' ? listView : gridView}

      {/* Lightbox */}
      <Dialog open={lightboxOpen} onOpenChange={(o) => { if (!o) closeLightbox() }}>
        <DialogContent className="sm:max-w-3xl p-0 overflow-hidden">
          <DialogHeader className="px-6 pt-5 pb-0">
            <DialogTitle className="font-mono text-sm font-normal truncate">
              {activeFile?.key.split('/').pop()}
            </DialogTitle>
          </DialogHeader>

          <div className="relative flex items-center justify-center bg-gray-950 min-h-64 max-h-[70vh] overflow-hidden">
            {activeFile && isImage(activeFile.key) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={activeFile.key}
                src={thumbnailUrl(activeFile.key, activeFile.etag, 1200)}
                alt={activeFile.key.split('/').pop()}
                className="max-w-full max-h-[70vh] object-contain"
              />
            ) : (
              <div className="text-center py-12">
                <p className="text-gray-400 text-sm">Preview not available for this file type.</p>
              </div>
            )}
            {files.length > 1 && (
              <>
                <button
                  onClick={e => { e.stopPropagation(); goTo((lightboxIndex ?? 0) - 1) }}
                  className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-black/50 hover:bg-black/70 p-2 text-white transition-colors"
                  aria-label="Previous"
                >
                  <ChevronLeftIcon className="w-5 h-5" />
                </button>
                <button
                  onClick={e => { e.stopPropagation(); goTo((lightboxIndex ?? 0) + 1) }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-black/50 hover:bg-black/70 p-2 text-white transition-colors"
                  aria-label="Next"
                >
                  <ChevronRightIcon className="w-5 h-5" />
                </button>
              </>
            )}
          </div>

          <div className="flex items-center justify-between px-6 py-4">
            <p className="text-xs text-gray-500">
              {lightboxIndex !== null ? lightboxIndex + 1 : '—'} / {files.length}
              {activeFile && <span className="ml-2">· {formatBytes(activeFile.size)}</span>}
            </p>
            <div className="flex items-center gap-2">
              {canWrite && activeFile && (
                <select
                  value={splits.get(activeFile.key) ?? 'none'}
                  onChange={e => handleSplitChange(activeFile.key, e.target.value as SplitChoice)}
                  className={cn(
                    'text-xs rounded border px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-400 cursor-pointer',
                    splitSelectClass(splits.get(activeFile.key) ?? null),
                  )}
                >
                  <option value="none">— unassigned</option>
                  <option value="train">train</option>
                  <option value="val">val</option>
                  <option value="test">test</option>
                </select>
              )}
              {!canWrite && activeFile && (
                <SplitBadge split={splits.get(activeFile.key) ?? null} />
              )}
              {canWrite && activeFile && (
                <button
                  onClick={() => activeFile && deleteSingle(activeFile.key)}
                  className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'text-destructive hover:text-destructive gap-1.5')}
                >
                  <Trash2Icon className="w-4 h-4" />
                  Delete
                </button>
              )}
              {dlLoading && <span className="text-xs text-gray-400">Preparing…</span>}
              {activeFile && (
                <button
                  onClick={() => downloadSingle(activeFile.key)}
                  disabled={dlLoading}
                  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5')}
                >
                  <DownloadIcon className="w-4 h-4" />
                  Download
                </button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Split assignment dialog */}
      <Dialog open={!!splitDialog} onOpenChange={(o) => { if (!o) { setSplitDialog(null); setPendingSplit(null) } }}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Assign split</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">
            {splitDialog?.keys.length === 1
              ? <>Assign a dataset split to <strong>{splitDialog.keys[0].split('/').pop()}</strong>.</>
              : <>Assign a dataset split to <strong>{splitDialog?.keys.length} files</strong>.</>}
          </p>
          <div className="flex flex-wrap gap-2 mt-1">
            {(['train', 'val', 'test'] as Split[]).map(s => (
              <button
                key={s}
                onClick={() => setPendingSplit(s)}
                className={cn(
                  'px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors',
                  pendingSplit === s
                    ? cn(SPLIT_STYLES[s], 'border-transparent ring-2 ring-offset-1',
                        s === 'train' ? 'ring-blue-400' : s === 'val' ? 'ring-amber-400' : 'ring-green-400')
                    : 'border-gray-200 text-gray-600 hover:border-gray-400',
                )}
              >
                {s}
              </button>
            ))}
            <button
              onClick={() => setPendingSplit('none')}
              className={cn(
                'px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors',
                pendingSplit === 'none'
                  ? 'bg-gray-100 border-gray-400 text-gray-700 ring-2 ring-offset-1 ring-gray-400'
                  : 'border-gray-200 text-gray-400 hover:border-gray-400',
              )}
            >
              Clear
            </button>
          </div>
          {/* Reassignment warning */}
          {pendingSplit !== null && splitDialog !== null && splitDialog.keys.some(k => {
            const cur = splits.get(k) ?? null
            const target = pendingSplit === 'none' ? null : pendingSplit
            return cur !== null && cur !== target
          }) && (
            <p className="text-sm text-amber-600 flex items-start gap-1.5 mt-1">
              <span className="shrink-0">⚠️</span>
              <span>
                {splitDialog.keys.filter(k => {
                  const cur = splits.get(k) ?? null
                  const target = pendingSplit === 'none' ? null : pendingSplit
                  return cur !== null && cur !== target
                }).length} file(s) already have a split assigned and will be reassigned.
              </span>
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setSplitDialog(null); setPendingSplit(null) }}>Cancel</Button>
            <Button
              onClick={confirmSplitAssign}
              disabled={pendingSplit === null}
            >
              {splitDialog !== null && pendingSplit !== null && splitDialog.keys.some(k => {
                const cur = splits.get(k) ?? null
                const target = pendingSplit === 'none' ? null : pendingSplit
                return cur !== null && cur !== target
              }) ? 'Confirm reassignment' : 'Assign'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
