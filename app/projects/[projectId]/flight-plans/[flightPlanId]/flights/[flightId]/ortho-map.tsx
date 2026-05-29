'use client'

import { useEffect, useRef, useState } from 'react'

interface OrthoMapProps {
  outputKey: string
}

export default function OrthoMap({ outputKey }: OrthoMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<{ remove(): void } | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    if (!containerRef.current) return
    let cancelled = false

    async function init() {
      try {
        // Fetch tile bounds + zoom range from the Modal tile server (via Next.js proxy)
        const infoRes = await fetch(`/api/tiles/info?key=${encodeURIComponent(outputKey)}`)
        if (!infoRes.ok) throw new Error(`Failed to load tile info (${infoRes.status})`)
        const { bounds, minzoom, maxzoom } = (await infoRes.json()) as {
          bounds: [number, number, number, number] // [W, S, E, N]
          minzoom: number
          maxzoom: number
        }

        if (cancelled || !containerRef.current) return

        const maplibre = (await import('maplibre-gl')).default
        await import('maplibre-gl/dist/maplibre-gl.css')

        if (cancelled || !containerRef.current) return

        // Use a relative tile URL — Next.js proxy adds the Modal auth header server-side
        const tileUrl = `/api/tiles/{z}/{x}/{y}?key=${encodeURIComponent(outputKey)}`

        const map = new maplibre.Map({
          container: containerRef.current,
          style: 'https://tiles.openfreemap.org/styles/liberty',
          bounds: [bounds[0], bounds[1], bounds[2], bounds[3]],
          fitBoundsOptions: { padding: 20 },
          attributionControl: false,
        })

        mapRef.current = map
        map.addControl(new maplibre.AttributionControl({ compact: true }))

        map.on('load', () => {
          if (cancelled) return
          map.addSource('ortho', {
            type: 'raster',
            tiles: [tileUrl],
            tileSize: 256,
            minzoom,
            maxzoom,
          })
          map.addLayer({ id: 'ortho-layer', type: 'raster', source: 'ortho' })
          setStatus('ready')
        })
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('[OrthoMap] error:', err)
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
      }
    }
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
