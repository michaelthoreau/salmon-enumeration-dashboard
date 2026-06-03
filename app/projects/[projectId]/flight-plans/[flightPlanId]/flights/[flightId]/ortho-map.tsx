'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import 'maplibre-gl/dist/maplibre-gl.css'

interface OrthoMapProps {
  outputKey: string
  className?: string
  fitBoundsTrigger?: number
  onViewportChange?: (viewport: { center: [number, number]; zoom: number }) => void
}

export default function OrthoMap({ outputKey, className, fitBoundsTrigger, onViewportChange }: OrthoMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any | null>(null)
  const mapReadyRef = useRef(false)
  const boundsRef = useRef<[number, number, number, number] | null>(null)
  const initialFitDoneRef = useRef(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')

  // ── Init map once ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    let cancelled = false

    async function init() {
      try {
        const maplibre = (await import('maplibre-gl')).default
        if (cancelled || !containerRef.current) return

        const map = new maplibre.Map({
          container: containerRef.current,
          style: 'https://tiles.openfreemap.org/styles/liberty',
          zoom: 2,
          center: [0, 20],
          attributionControl: false,
        })

        mapRef.current = map
        map.addControl(new maplibre.AttributionControl({ compact: true }))

        map.on('moveend', () => {
          if (cancelled) return
          onViewportChange?.({
            center: map.getCenter().toArray() as [number, number],
            zoom: map.getZoom(),
          })
        })

        map.on('load', () => {
          if (cancelled) return
          mapReadyRef.current = true
          map.resize()
          // Source/layer added by the outputKey effect below
        })
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('[OrthoMap] init error:', err)
          setErrorMsg(msg)
          setStatus('error')
        }
      }
    }

    init()

    return () => {
      cancelled = true
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
        mapReadyRef.current = false
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // run once

  // ── Swap layer when outputKey changes ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function applyLayer() {
      setStatus('loading')
      try {
        const infoRes = await fetch(`/api/tiles/info?key=${encodeURIComponent(outputKey)}`)
        if (!infoRes.ok) throw new Error(`Failed to load tile info (${infoRes.status})`)
        const { bounds, minzoom, maxzoom } = (await infoRes.json()) as {
          bounds: [number, number, number, number]
          minzoom: number
          maxzoom: number
        }

        if (cancelled) return

        const tileUrl = `/api/tiles/{z}/{x}/{y}?key=${encodeURIComponent(outputKey)}`

        // Wait for the map to be ready (style loaded)
        await new Promise<void>((resolve) => {
          if (mapReadyRef.current && mapRef.current) return resolve()
          const check = setInterval(() => {
            if (cancelled || !mapRef.current) { clearInterval(check); return }
            if (mapReadyRef.current) { clearInterval(check); resolve() }
          }, 100)
        })

        if (cancelled || !mapRef.current) return
        const map = mapRef.current

        // Remove existing ortho layer/source if present
        if (map.getLayer('ortho-layer')) map.removeLayer('ortho-layer')
        if (map.getSource('ortho')) map.removeSource('ortho')

        map.addSource('ortho', {
          type: 'raster',
          tiles: [tileUrl],
          tileSize: 256,
          minzoom,
          maxzoom,
        })
        map.addLayer({ id: 'ortho-layer', type: 'raster', source: 'ortho' })
        
        boundsRef.current = bounds
        if (!initialFitDoneRef.current) {
          map.resize()
          setTimeout(() => {
            if (!cancelled && mapRef.current) {
              mapRef.current.fitBounds([bounds[0], bounds[1], bounds[2], bounds[3]], { padding: 20, animate: false })
            }
          }, 100)
          initialFitDoneRef.current = true
        }

        setStatus('ready')
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('[OrthoMap] layer error:', err)
          setErrorMsg(msg)
          setStatus('error')
        }
      }
    }

    applyLayer()
    return () => { cancelled = true }
  }, [outputKey])

  // ── Fit bounds when fitBoundsTrigger changes ────────────────────────────────
  useEffect(() => {
    if (fitBoundsTrigger && fitBoundsTrigger > 0 && mapRef.current && boundsRef.current) {
      mapRef.current.resize()
      mapRef.current.fitBounds(boundsRef.current, { padding: 20, animate: true, duration: 300 })
    }
  }, [fitBoundsTrigger])

  return (
    <div className={cn("relative w-full bg-gray-100", className || "h-96 rounded-xl border border-gray-200 overflow-hidden")}>
      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <p className="text-sm text-gray-500">Loading orthophoto…</p>
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center z-10">
          <p className="text-sm text-red-500 px-4 text-center">{errorMsg}</p>
        </div>
      )}
      <div ref={containerRef} className="w-full h-full" />
    </div>
  )
}
