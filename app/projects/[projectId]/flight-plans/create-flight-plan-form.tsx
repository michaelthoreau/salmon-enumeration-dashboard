'use client'

import { useActionState, useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createFlightPlan, findOrCreateFlightPlan } from '@/app/actions/flight-plans'
import { createFlightForUpload } from '@/app/actions/flights'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { Upload, FolderOpen, Loader2 } from 'lucide-react'

interface DetectedFlight {
  folderName: string
  timestamp: string
  files: File[]
}

const CONCURRENCY = 6
const VIDEO_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'mp4', 'mov'])

function parseDjiTimestamp(folderName: string): string | null {
  const m = folderName.match(/DJI_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/)
  if (m) {
    const [, y, mo, d, h, mi] = m
    return `${y}-${mo}-${d}T${h}:${mi}`
  }
  return null
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatTimestamp(ts: string): string {
  const [date, time] = ts.split('T')
  return `${date} at ${time}`
}

async function uploadFileToS3(
  file: File,
  presigned: { url: string; fields: Record<string, string> },
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const formData = new FormData()
    for (const [key, val] of Object.entries(presigned.fields)) {
      formData.append(key, val)
    }
    formData.append('file', file)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`S3 upload failed: ${xhr.status}`))
    }
    xhr.onerror = () => reject(new Error('Network error'))
    xhr.open('POST', presigned.url)
    xhr.send(formData)
  })
}

export default function CreateFlightPlanForm({ projectId, timezone }: { projectId: string; timezone: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'manual' | 'upload'>('manual')
  const [state, action, pending] = useActionState(createFlightPlan, null)

  // Upload folder state
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [routeName, setRouteName] = useState('')
  const [detectedFlights, setDetectedFlights] = useState<DetectedFlight[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadStage, setUploadStage] = useState('')
  const [overallProgress, setOverallProgress] = useState(0)
  const [flightProgress, setFlightProgress] = useState<Record<string, { done: number; total: number }>>({})
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadDone, setUploadDone] = useState(false)

  useEffect(() => {
    if (state?.success) setOpen(false)
  }, [state])

  const handleFolderSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return

    // Group files by subfolder
    const subfolders = new Map<string, File[]>()
    let topFolderName = ''

    for (const file of files) {
      const parts = file.webkitRelativePath.split('/')
      if (!topFolderName && parts.length >= 1) topFolderName = parts[0]

      const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
      if (!VIDEO_IMAGE_EXTS.has(ext)) continue

      if (parts.length >= 3) {
        const subfolder = parts[1]
        if (!subfolders.has(subfolder)) subfolders.set(subfolder, [])
        subfolders.get(subfolder)!.push(file)
      } else if (parts.length === 2) {
        const key = '__root__'
        if (!subfolders.has(key)) subfolders.set(key, [])
        subfolders.get(key)!.push(file)
      }
    }

    setRouteName(topFolderName)

    const flights: DetectedFlight[] = []
    for (const [folder, folderFiles] of subfolders) {
      const timestamp = parseDjiTimestamp(folder)
      flights.push({
        folderName: folder,
        timestamp: timestamp ?? new Date().toISOString().slice(0, 16),
        files: folderFiles,
      })
    }

    flights.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    setDetectedFlights(flights)
  }, [])

  const handleUpload = useCallback(async () => {
    if (!routeName.trim() || detectedFlights.length === 0) return
    setUploading(true)
    setUploadError(null)
    setUploadDone(false)

    try {
      // 1. Create or find flight plan
      setUploadStage('Creating route...')
      const plan = await findOrCreateFlightPlan(projectId, routeName, routeName)
      if (plan.error) throw new Error(plan.error)

      // 2. For each flight
      let totalFiles = detectedFlights.reduce((s, f) => s + f.files.length, 0)
      let completedFiles = 0

      for (const flight of detectedFlights) {
        setUploadStage(`Creating flight ${flight.folderName}...`)

        // Create flight
        const flightData = await createFlightForUpload({
          flightPlanId: plan.id,
          timestamp: flight.timestamp,
          timezone,
          notes: flight.folderName,
        })
        if (flightData.error) throw new Error(flightData.error)
        const flightId = flightData.id

        setFlightProgress((prev) => ({
          ...prev,
          [flight.folderName]: { done: 0, total: flight.files.length },
        }))

        // Get presigned URLs
        setUploadStage(`Uploading ${flight.files.length} files for ${flight.folderName}...`)
        const presignRes = await fetch('/api/upload/presign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            flightId,
            files: flight.files.map((f) => ({
              name: f.name,
              type: f.type || 'application/octet-stream',
              size: f.size,
            })),
          }),
        })
        if (!presignRes.ok) throw new Error(`Failed to get upload URLs for ${flight.folderName}`)
        const { uploads } = await presignRes.json()

        // Upload files with concurrency limit
        let flightDone = 0
        const queue = [...flight.files.map((file, i) => ({ file, presigned: uploads[i] }))]

        await new Promise<void>((resolve, reject) => {
          let active = 0
          let errored = false

          function next() {
            if (errored) return
            if (queue.length === 0 && active === 0) { resolve(); return }
            while (active < CONCURRENCY && queue.length > 0) {
              const item = queue.shift()!
              active++
              ;(async () => {
                try {
                  await uploadFileToS3(item.file, item.presigned, () => {})
                  await fetch('/api/files/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: item.presigned.fields.key, flightId }),
                  })
                  flightDone++
                  completedFiles++
                  setFlightProgress((prev) => ({
                    ...prev,
                    [flight.folderName]: { done: flightDone, total: flight.files.length },
                  }))
                  setOverallProgress(Math.round((completedFiles / totalFiles) * 100))
                } catch (err) {
                  if (!errored) { errored = true; reject(err) }
                } finally {
                  active--
                  next()
                }
              })()
            }
          }
          next()
        })
      }

      setUploadDone(true)
      setUploadStage('Done!')
      router.refresh()
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
    }
  }, [routeName, detectedFlights, projectId, timezone, router])

  const resetUpload = () => {
    setRouteName('')
    setDetectedFlights([])
    setUploadError(null)
    setUploadDone(false)
    setOverallProgress(0)
    setFlightProgress({})
    setUploadStage('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const totalFiles = detectedFlights.reduce((s, f) => s + f.files.length, 0)
  const totalSize = detectedFlights.reduce((s, f) => s + f.files.reduce((fs, file) => fs + file.size, 0), 0)

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        New flight route
      </Button>

      <Dialog open={open} onOpenChange={(v) => { if (!uploading) setOpen(v) }}>
        <DialogContent showCloseButton={!uploading} className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New flight route</DialogTitle>
          </DialogHeader>

          {/* Tab selector */}
          <div className="flex gap-1 bg-gray-100 p-1 rounded-lg">
            <button
              onClick={() => setTab('manual')}
              className={cn(
                "flex-1 text-sm font-medium py-1.5 rounded-md transition-colors",
                tab === 'manual' ? "bg-white shadow-sm text-gray-900" : "text-gray-500 hover:text-gray-700"
              )}
            >
              Manual
            </button>
            <button
              onClick={() => setTab('upload')}
              className={cn(
                "flex-1 text-sm font-medium py-1.5 rounded-md transition-colors flex items-center justify-center gap-1.5",
                tab === 'upload' ? "bg-white shadow-sm text-gray-900" : "text-gray-500 hover:text-gray-700"
              )}
            >
              <Upload className="w-3.5 h-3.5" />
              Upload Folder
            </button>
          </div>

          {/* Manual tab */}
          {tab === 'manual' && (
            <form action={action} className="flex flex-col gap-4 py-2">
              <input type="hidden" name="projectId" value={projectId} />

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="fp-name">Name</Label>
                <Input id="fp-name" name="name" required placeholder="flight-plan-name" />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="fp-display-name">Display Name</Label>
                <Input id="fp-display-name" name="displayName" placeholder="Optional display name override" />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="fp-description">Description</Label>
                <Input id="fp-description" name="description" placeholder="Optional description" />
              </div>

              {state?.error && <p className="text-sm text-destructive">{state.error}</p>}

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={pending}>{pending ? 'Creating...' : 'Create'}</Button>
              </DialogFooter>
            </form>
          )}

          {/* Upload folder tab */}
          {tab === 'upload' && !uploadDone && (
            <div className="py-2 space-y-4">
              {/* Hidden folder input */}
              <input
                ref={fileInputRef}
                type="file"
                // @ts-expect-error webkitdirectory is not in React types
                webkitdirectory=""
                multiple
                className="hidden"
                onChange={handleFolderSelect}
              />

              {detectedFlights.length === 0 ? (
                /* Folder picker */
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full border-2 border-dashed border-gray-300 rounded-xl p-8 flex flex-col items-center gap-3 hover:border-blue-400 hover:bg-blue-50/50 transition-colors cursor-pointer"
                >
                  <FolderOpen className="w-10 h-10 text-gray-300" />
                  <span className="text-sm text-gray-500">Select a folder with DJI flight subfolders</span>
                  <span className="text-xs text-gray-400">e.g. June 20 AM / DJI_202606200730_007_...</span>
                </button>
              ) : (
                /* Preview detected flights */
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label>Route Name</Label>
                    <Input
                      value={routeName}
                      onChange={(e) => setRouteName(e.target.value)}
                      disabled={uploading}
                    />
                  </div>

                  <div className="text-xs text-gray-500 flex items-center justify-between">
                    <span>{detectedFlights.length} flight{detectedFlights.length !== 1 ? 's' : ''} detected</span>
                    <span>{totalFiles} files · {formatBytes(totalSize)}</span>
                  </div>

                  <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                    {detectedFlights.map((f) => {
                      const prog = flightProgress[f.folderName]
                      return (
                        <div key={f.folderName} className="px-3 py-2 text-sm">
                          <div className="flex justify-between items-center">
                            <span className="font-medium text-gray-800 truncate max-w-[280px]">{f.folderName}</span>
                            {prog ? (
                              <span className={cn("text-xs font-mono", prog.done === prog.total ? "text-green-600" : "text-blue-600")}>
                                {prog.done}/{prog.total}
                              </span>
                            ) : (
                              <span className="text-xs text-gray-400">{f.files.length} files</span>
                            )}
                          </div>
                          <div className="text-xs text-gray-400 mt-0.5">{formatTimestamp(f.timestamp)}</div>
                        </div>
                      )
                    })}
                  </div>

                  {uploading && (
                    <div className="space-y-2">
                      <div className="flex justify-between text-xs text-gray-500">
                        <span>{uploadStage}</span>
                        <span>{overallProgress}%</span>
                      </div>
                      <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full transition-all duration-300"
                          style={{ width: `${overallProgress}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {uploadError && (
                    <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">{uploadError}</p>
                  )}

                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={resetUpload} disabled={uploading}>
                      {uploading ? 'Uploading...' : 'Change folder'}
                    </Button>
                    <Button onClick={handleUpload} disabled={uploading || !routeName.trim()}>
                      {uploading ? (
                        <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Uploading...</>
                      ) : (
                        `Create & Upload (${totalFiles} files)`
                      )}
                    </Button>
                  </DialogFooter>
                </>
              )}
            </div>
          )}

          {/* Upload done */}
          {tab === 'upload' && uploadDone && (
            <div className="py-8 text-center space-y-3">
              <div className="text-4xl">✅</div>
              <p className="text-sm font-medium text-gray-900">Upload Complete</p>
              <p className="text-xs text-gray-500">
                {detectedFlights.length} flight{detectedFlights.length !== 1 ? 's' : ''} with {totalFiles} files uploaded to "{routeName}"
              </p>
              <div className="flex justify-center gap-2 pt-2">
                <Button variant="outline" onClick={() => { resetUpload(); setOpen(false) }}>Close</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
