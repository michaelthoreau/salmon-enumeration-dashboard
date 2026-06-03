'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface FileStatus {
  file: File
  status: 'queued' | 'uploading' | 'done' | 'error'
  progress: number // 0-100
  error?: string
}

const CONCURRENCY = 6 // simultaneous S3 uploads

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`
  return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`
}

async function uploadFile(
  file: File,
  url: string,
  fields: Record<string, string>,
  onProgress: (pct: number) => void,
  onBytesLoaded: (loaded: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const formData = new FormData()
    for (const [k, v] of Object.entries(fields)) formData.append(k, v)
    formData.append('file', file) // must be last per S3 presigned POST spec

    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100))
        onBytesLoaded(e.loaded)
      }
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100)
        resolve()
      } else {
        reject(new Error(`S3 responded ${xhr.status}`))
      }
    }

    xhr.onerror = () => reject(new Error('Network error'))
    xhr.send(formData)
  })
}

export default function FlightUploader({
  flightId,
  defaultOpen = false,
  hasFiles = true,
}: {
  flightId: string
  defaultOpen?: boolean
  hasFiles?: boolean
}) {
  const [statuses, setStatuses] = useState<FileStatus[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [uploadSpeed, setUploadSpeed] = useState<number | null>(null)
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  // Tracks bytes loaded per file index for speed calculation
  const fileLoadedRef = useRef<number[]>([])
  const speedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const updateStatus = useCallback(
    (index: number, patch: Partial<FileStatus>) => {
      setStatuses((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)))
    },
    [],
  )

  const startUpload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return

      const initial: FileStatus[] = files.map((file) => ({
        file,
        status: 'queued',
        progress: 0,
      }))
      setStatuses(initial)
      setIsRunning(true)
      setUploadSpeed(null)
      fileLoadedRef.current = new Array(files.length).fill(0)

      // Sample total loaded bytes every 500 ms to compute speed
      let lastTotal = 0
      let lastTime = Date.now()
      speedIntervalRef.current = setInterval(() => {
        const total = fileLoadedRef.current.reduce((a, b) => a + b, 0)
        const now = Date.now()
        const dt = (now - lastTime) / 1000
        if (dt > 0) setUploadSpeed((total - lastTotal) / dt)
        lastTotal = total
        lastTime = now
      }, 500)

      // Fetch presigned URLs for all files in one request
      let uploads: { name: string; url: string; fields: Record<string, string> }[]
      try {
        const res = await fetch('/api/upload/presign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            flightId,
            files: files.map((f) => ({ name: f.name, type: f.type || 'application/octet-stream', size: f.size })),
          }),
        })
        if (!res.ok) {
          const { error } = await res.json()
          throw new Error(error ?? `Server error ${res.status}`)
        }
        const data = await res.json()
        uploads = data.uploads
      } catch (err) {
        setStatuses((prev) =>
          prev.map((s) => ({ ...s, status: 'error', error: String(err) })),
        )
        setIsRunning(false)
        return
      }

      // Upload with bounded concurrency
      let idx = 0
      async function worker() {
        while (idx < uploads.length) {
          const i = idx++
          const { url, fields } = uploads[i]
          updateStatus(i, { status: 'uploading' })
          try {
            await uploadFile(files[i], url, fields,
              (pct) => updateStatus(i, { progress: pct }),
              (loaded) => { fileLoadedRef.current[i] = loaded },
            )
            // Register the file in the DB to record its key and ETag
            await fetch('/api/files/register', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key: fields.key, flightId }),
            })
            updateStatus(i, { status: 'done', progress: 100 })
          } catch (err) {
            updateStatus(i, { status: 'error', error: String(err) })
          }
        }
      }

      const workers = Array.from({ length: Math.min(CONCURRENCY, uploads.length) }, worker)
      await Promise.all(workers)

      if (speedIntervalRef.current) clearInterval(speedIntervalRef.current)
      setUploadSpeed(null)
      setIsRunning(false)
      router.refresh() // refresh server component to show updated S3 file list
    },
    [flightId, updateStatus, router],
  )

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) startUpload(Array.from(e.target.files))
  }

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      dropRef.current?.classList.remove('border-blue-500', 'bg-blue-50')
      const items = e.dataTransfer.items
      const files: File[] = []
      for (const item of items) {
        if (item.kind === 'file') {
          const f = item.getAsFile()
          if (f) files.push(f)
        }
      }
      if (files.length) startUpload(files)
    },
    [startUpload],
  )

  const done = statuses.filter((s) => s.status === 'done').length
  const errors = statuses.filter((s) => s.status === 'error').length
  const total = statuses.length
  const [open, setOpen] = useState(defaultOpen)

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        className={cn(
          "w-full flex items-center justify-center gap-2",
          !hasFiles && "animate-pulse border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 hover:text-blue-800 shadow-sm"
        )}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
        </svg>
        Upload Files
      </Button>

      <Dialog open={open} onOpenChange={(v) => { if (!isRunning) setOpen(v) }}>
        <DialogContent className="sm:max-w-xl" showCloseButton={!isRunning}>
          <DialogHeader>
            <DialogTitle>Upload Files</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 pt-2">
            {/* Drop zone */}
            <div
              ref={dropRef}
              onDragOver={(e) => {
                e.preventDefault()
                dropRef.current?.classList.add('border-blue-500', 'bg-blue-50')
              }}
              onDragLeave={() => {
                dropRef.current?.classList.remove('border-blue-500', 'bg-blue-50')
              }}
              onDrop={onDrop}
              onClick={() => !isRunning && inputRef.current?.click()}
              className="flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 px-8 py-12 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors"
            >
              <svg className="w-10 h-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
              <div>
                <p className="text-sm font-medium text-gray-700">
                  {isRunning ? 'Uploading…' : 'Drop files here or click to browse'}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  Images (JPEG, PNG, TIFF), video (MP4, MOV) — up to 5 GB each — up to 500 files
                </p>
              </div>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept="image/jpeg,image/png,image/tiff,image/webp,video/mp4,video/quicktime,application/octet-stream"
                className="hidden"
                onChange={onFileInputChange}
                disabled={isRunning}
              />
            </div>

            {/* Progress list */}
            {statuses.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-700 font-medium">
                    {done}/{total} uploaded
                    {errors > 0 && (
                      <span className="ml-2 text-red-600">{errors} failed</span>
                    )}
                    {isRunning && uploadSpeed !== null && uploadSpeed > 0 && (
                      <span className="ml-3 text-blue-600">{formatSpeed(uploadSpeed)}</span>
                    )}
                  </span>
                  {!isRunning && (
                    <button
                      onClick={() => {
                        setStatuses([])
                        if (inputRef.current) inputRef.current.value = ''
                      }}
                      className="text-xs text-gray-500 hover:underline"
                    >
                      Clear
                    </button>
                  )}
                </div>

                <div className="max-h-64 overflow-y-auto space-y-1 rounded-lg border border-gray-200 bg-white p-3">
                  {statuses.map((s, i) => (
                    <div key={i} className="flex items-center gap-3 text-xs">
                      {/* Status icon */}
                      <span className="w-4 shrink-0 text-center">
                        {s.status === 'done' && <span className="text-green-500">✓</span>}
                        {s.status === 'error' && <span className="text-red-500">✗</span>}
                        {s.status === 'queued' && <span className="text-gray-400">○</span>}
                        {s.status === 'uploading' && (
                          <span className="inline-block w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                        )}
                      </span>

                      {/* Filename */}
                      <span className="flex-1 truncate font-mono text-gray-700">{s.file.name}</span>
                      <span className="text-gray-400 shrink-0">{formatBytes(s.file.size)}</span>

                      {/* Progress bar */}
                      {s.status === 'uploading' && (
                        <div className="w-20 h-1.5 rounded-full bg-gray-200 overflow-hidden shrink-0">
                          <div
                            className="h-full bg-blue-500 transition-all"
                            style={{ width: `${s.progress}%` }}
                          />
                        </div>
                      )}

                      {s.status === 'error' && (
                        <span className="text-red-500 truncate max-w-[160px]">{s.error}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
