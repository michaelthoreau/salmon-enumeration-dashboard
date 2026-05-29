'use client'

import { useEffect, useRef, useState } from 'react'

interface OrthoMapProps {
  outputKey: string
}

export default function OrthoMap({ outputKey }: OrthoMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any | null>(null)
  const mapReadyRef = useRef(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')

  // ── Init map once ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    let cancelled = false

    async function init() {
      try {
        const maplibre = (await import('maplibre-gl')).default
        await import('maplibre-gl/dist/maplibre-gl.css')
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

        map.on('load', () => {
          if (cancelled) return
          mapReadyRef.current = true
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
        map.fitBounds([bounds[0], bounds[1], bounds[2], bounds[3]], { padding: 20, animate: true })

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

  return (
    <div className="relative w-full h-96 rounded-xl overflow-hidden border border-gray-200 bg-gray-100">
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
