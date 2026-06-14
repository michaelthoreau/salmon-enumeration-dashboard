'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { X, Sliders, Maximize2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'
import 'maplibre-gl/dist/maplibre-gl.css'

interface CompareMapProps {
  flightAId: string
  flightBId: string
  flightsWithOrtho: {
    flightId: string
    formattedTime: string
    outputKey: string
  }[]
  initialViewport?: {
    center: [number, number]
    zoom: number
  } | null
  onFlightAChange: (id: string) => void
  onFlightBChange: (id: string) => void
  onExit: () => void
}

export default function CompareMap({
  flightAId,
  flightBId,
  flightsWithOrtho,
  initialViewport,
  onFlightAChange,
  onFlightBChange,
  onExit,
}: CompareMapProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const containerBeforeRef = useRef<HTMLDivElement>(null)
  const containerAfterRef = useRef<HTMLDivElement>(null)
  
  const mapBeforeRef = useRef<any | null>(null)
  const mapAfterRef = useRef<any | null>(null)
  
  const mapBeforeReadyRef = useRef(false)
  const mapAfterReadyRef = useRef(false)
  
  const [sliderPosition, setSliderPosition] = useState(50)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [showDiff, setShowDiff] = useState(false)
  const [colormap, setColormap] = useState<'red-green' | 'red-blue' | 'grayscale'>('red-green')
  const [threshold, setThreshold] = useState(15)
  const [sensitivity, setSensitivity] = useState(180)

  const maxDiff = 300 - sensitivity

  const isDraggingRef = useRef(false)
  const boundsRef = useRef<[number, number, number, number] | null>(null)

  const [boundsA, setBoundsA] = useState<[number, number, number, number] | null>(null)
  const [boundsB, setBoundsB] = useState<[number, number, number, number] | null>(null)

  const flightA = flightsWithOrtho.find(f => f.flightId === flightAId)
  const flightB = flightsWithOrtho.find(f => f.flightId === flightBId)

  // ── Init both maps ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerBeforeRef.current || !containerAfterRef.current) return
    let cancelled = false

    async function init() {
      try {
        const maplibre = (await import('maplibre-gl')).default
        if (cancelled) return
 
        // Init Before Map
        const mapBefore = new maplibre.Map({
          container: containerBeforeRef.current!,
          style: 'https://tiles.openfreemap.org/styles/liberty',
          zoom: initialViewport?.zoom ?? 2,
          center: initialViewport?.center ?? [0, 20],
          attributionControl: false,
        })
        mapBeforeRef.current = mapBefore
 
        // Init After Map
        const mapAfter = new maplibre.Map({
          container: containerAfterRef.current!,
          style: 'https://tiles.openfreemap.org/styles/liberty',
          zoom: initialViewport?.zoom ?? 2,
          center: initialViewport?.center ?? [0, 20],
          attributionControl: false,
        })
        mapAfterRef.current = mapAfter
 
        // Wait for styles to load
        mapBefore.on('load', () => {
          if (cancelled) return
          mapBeforeReadyRef.current = true
          mapBefore.resize()
        })
 
        mapAfter.on('load', () => {
          if (cancelled) return
          mapAfterReadyRef.current = true
          mapAfter.resize()
        })

        // ── Camera Synchronization ───────────────────────────────────────────
        let isSyncing = false

        const syncBeforeToAfter = () => {
          if (isSyncing || !mapBeforeRef.current || !mapAfterRef.current) return
          isSyncing = true
          mapAfterRef.current.setCenter(mapBeforeRef.current.getCenter())
          mapAfterRef.current.setZoom(mapBeforeRef.current.getZoom())
          mapAfterRef.current.setBearing(mapBeforeRef.current.getBearing())
          mapAfterRef.current.setPitch(mapBeforeRef.current.getPitch())
          isSyncing = false
        }

        const syncAfterToBefore = () => {
          if (isSyncing || !mapBeforeRef.current || !mapAfterRef.current) return
          isSyncing = true
          mapBeforeRef.current.setCenter(mapAfterRef.current.getCenter())
          mapBeforeRef.current.setZoom(mapAfterRef.current.getZoom())
          mapBeforeRef.current.setBearing(mapAfterRef.current.getBearing())
          mapBeforeRef.current.setPitch(mapAfterRef.current.getPitch())
          isSyncing = false
        }

        mapBefore.on('move', syncBeforeToAfter)
        mapAfter.on('move', syncAfterToBefore)

      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('[CompareMap] init error:', err)
          setErrorMsg(msg)
          setStatus('error')
        }
      }
    }

    init()

    return () => {
      cancelled = true
      if (mapBeforeRef.current) {
        mapBeforeRef.current.remove()
        mapBeforeRef.current = null
      }
      if (mapAfterRef.current) {
        mapAfterRef.current.remove()
        mapAfterRef.current = null
      }
      mapBeforeReadyRef.current = false
      mapAfterReadyRef.current = false
    }
  }, [initialViewport])

  // ── Swap layer A (Before) ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function applyLayerA() {
      // Wait for mapBefore to be ready
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (cancelled || !mapBeforeRef.current) { clearInterval(check); return }
          if (mapBeforeReadyRef.current) { clearInterval(check); resolve() }
        }, 100)
      })

      if (cancelled || !mapBeforeRef.current) return
      const map = mapBeforeRef.current

      if (map.getLayer('ortho-before-layer')) map.removeLayer('ortho-before-layer')
      if (map.getSource('ortho-before')) map.removeSource('ortho-before')

      if (!flightA) {
        setBoundsA(null)
        return
      }

      try {
        const infoRes = await fetch(`/api/tiles/info?key=${encodeURIComponent(flightA.outputKey)}`)
        if (!infoRes.ok) throw new Error(`Failed to load tile info A (${infoRes.status})`)
        const { bounds, minzoom, maxzoom } = (await infoRes.json()) as {
          bounds: [number, number, number, number]
          minzoom: number
          maxzoom: number
        }

        if (cancelled || !mapBeforeRef.current) return
        const tileUrl = `/api/tiles/{z}/{x}/{y}?key=${encodeURIComponent(flightA.outputKey)}`

        map.addSource('ortho-before', {
          type: 'raster',
          tiles: [tileUrl],
          tileSize: 256,
          minzoom: 0,
          maxzoom,
        })
        map.addLayer({ id: 'ortho-before-layer', type: 'raster', source: 'ortho-before' })

        boundsRef.current = bounds
        setBoundsA(bounds)
      } catch (err) {
        console.error('[CompareMap] layer A error:', err)
      }
    }

    applyLayerA()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flightAId])

  // ── Swap layer B (After) ───────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function applyLayerB() {
      // Wait for mapAfter to be ready
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (cancelled || !mapAfterRef.current) { clearInterval(check); return }
          if (mapAfterReadyRef.current) { clearInterval(check); resolve() }
        }, 100)
      })

      if (cancelled || !mapAfterRef.current) return
      const map = mapAfterRef.current

      if (map.getLayer('ortho-after-layer')) map.removeLayer('ortho-after-layer')
      if (map.getSource('ortho-after')) map.removeSource('ortho-after')

      if (!flightB) {
        setBoundsB(null)
        setStatus('ready')
        return
      }

      try {
        const infoRes = await fetch(`/api/tiles/info?key=${encodeURIComponent(flightB.outputKey)}`)
        if (!infoRes.ok) throw new Error(`Failed to load tile info B (${infoRes.status})`)
        const { bounds, minzoom, maxzoom } = (await infoRes.json()) as {
          bounds: [number, number, number, number]
          minzoom: number
          maxzoom: number
        }

        if (cancelled || !mapAfterRef.current) return
        
        let tileUrl: string
        if (showDiff && flightA) {
          tileUrl = `/api/tiles/diff/{z}/{x}/{y}?key1=${encodeURIComponent(flightA.outputKey)}&key2=${encodeURIComponent(flightB.outputKey)}&colormap=${colormap}&threshold=${threshold}&maxDiff=${maxDiff}`
        } else {
          tileUrl = `/api/tiles/{z}/{x}/{y}?key=${encodeURIComponent(flightB.outputKey)}`
        }

        map.addSource('ortho-after', {
          type: 'raster',
          tiles: [tileUrl],
          tileSize: 256,
          minzoom: 0,
          maxzoom,
        })
        map.addLayer({ id: 'ortho-after-layer', type: 'raster', source: 'ortho-after' })

        setBoundsB(bounds)
        setStatus('ready')
      } catch (err) {
        console.error('[CompareMap] layer B error:', err)
      }
    }

    applyLayerB()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flightBId, flightAId, showDiff, colormap, threshold, maxDiff])

  // ── Slider dragging logic ──────────────────────────────────────────────────
  const startDragging = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingRef.current = true
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !rootRef.current) return
      const rect = rootRef.current.getBoundingClientRect()
      const x = e.clientX - rect.left
      const percentage = Math.max(0, Math.min(100, (x / rect.width) * 100))
      setSliderPosition(percentage)
    }

    const handleMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false
        document.body.style.removeProperty('cursor')
        document.body.style.removeProperty('user-select')
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  // ── Smooth Zoom Handlers ───────────────────────────────────────────────────
  const handleZoomA = () => {
    if (mapBeforeRef.current && boundsA) {
      mapBeforeRef.current.resize()
      mapBeforeRef.current.fitBounds(boundsA, { padding: 20, animate: true, duration: 300 })
    }
  }

  const handleZoomB = () => {
    if (mapAfterRef.current && boundsB) {
      mapAfterRef.current.resize()
      mapAfterRef.current.fitBounds(boundsB, { padding: 20, animate: true, duration: 300 })
    }
  }

  return (
    <div ref={rootRef} className="absolute inset-0 bg-gray-100 overflow-hidden">
      {/* Map A: Before (Background, fully visible) */}
      <div ref={containerBeforeRef} className="!absolute inset-0 z-10 w-full h-full" />

      {/* Map B: After (Foreground, clipped) */}
      <div
        ref={containerAfterRef}
        style={{ clipPath: `inset(0 0 0 ${sliderPosition}%)` }}
        className="!absolute inset-0 z-20 w-full h-full"
      />

      {/* Vertical Slider Bar */}
      <div
        style={{ left: `${sliderPosition}%` }}
        className="absolute top-0 bottom-0 w-1 bg-white shadow-2xl z-30 cursor-ew-resize -translate-x-[2px] transition-colors hover:bg-blue-400 group"
        onMouseDown={startDragging}
      >
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white shadow-lg border border-gray-200 flex items-center justify-center text-gray-500 group-hover:text-blue-500 transition-colors pointer-events-auto cursor-ew-resize select-none">
          <Sliders className="w-4 h-4 rotate-90 pointer-events-none" />
        </div>
      </div>

      {/* Left Selector (Centered in the Left half - Fixed at 25%) */}
      <div
        className="absolute top-4 left-1/4 -translate-x-1/2 z-40 bg-white/95 backdrop-blur-sm px-4 py-2 rounded-xl shadow-lg border border-gray-200/80 flex flex-col gap-0.5 items-center min-w-[160px] pointer-events-auto"
      >
        <span className="text-[9px] font-semibold text-blue-600 uppercase tracking-wider">Before (Left)</span>
        <div className="flex items-center gap-1.5 w-full mt-0.5">
          <select
            value={flightAId}
            onChange={(e) => onFlightAChange(e.target.value)}
            className="flex-1 text-xs font-semibold text-gray-700 bg-transparent border-none p-0 focus:ring-0 focus:outline-none cursor-pointer text-center mt-0.5"
          >
            <option value="none">None (Base Map)</option>
            {flightsWithOrtho.map(f => (
              <option key={f.flightId} value={f.flightId}>
                {f.formattedTime}
              </option>
            ))}
          </select>
          <button
            onClick={handleZoomA}
            disabled={!boundsA}
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'icon-xs' }),
              "text-gray-400 hover:text-gray-600 disabled:opacity-40 h-6 w-6 rounded-md hover:bg-gray-100 flex-shrink-0"
            )}
            title="Zoom to before flight bounds"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Right Selector (Centered in the Right half - Fixed at 75%) */}
      <div
        className="absolute top-4 left-3/4 -translate-x-1/2 z-40 bg-white/95 backdrop-blur-sm px-4 py-3 rounded-2xl shadow-xl border border-gray-200/80 flex flex-col gap-1 items-center min-w-[200px] pointer-events-auto"
      >
        <span className="text-[9px] font-semibold text-amber-600 uppercase tracking-wider">
          {showDiff && flightAId !== 'none' && flightBId !== 'none' ? 'Difference (R - L)' : 'After (Right)'}
        </span>
        <div className="flex items-center gap-1.5 w-full mt-0.5">
          <select
            value={flightBId}
            onChange={(e) => onFlightBChange(e.target.value)}
            className="flex-1 text-xs font-semibold text-gray-700 bg-transparent border-none p-0 focus:ring-0 focus:outline-none cursor-pointer text-center mt-0.5"
          >
            <option value="none">None (Base Map)</option>
            {flightsWithOrtho.map(f => (
              <option key={f.flightId} value={f.flightId}>
                {f.formattedTime}
              </option>
            ))}
          </select>
          <button
            onClick={handleZoomB}
            disabled={!boundsB}
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'icon-xs' }),
              "text-gray-400 hover:text-gray-600 disabled:opacity-40 h-6 w-6 rounded-md hover:bg-gray-100 flex-shrink-0"
            )}
            title="Zoom to after flight bounds"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {flightAId !== 'none' && flightBId !== 'none' && (
          <div className="flex flex-col gap-2.5 mt-2.5 pt-2.5 border-t border-gray-100 w-full animate-in fade-in slide-in-from-top-1 duration-150">
            <div className="flex items-center gap-2 justify-center">
              <input
                type="checkbox"
                id="diff-mode-toggle"
                checked={showDiff}
                onChange={(e) => setShowDiff(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-gray-300 text-amber-600 focus:ring-amber-500 cursor-pointer"
              />
              <label htmlFor="diff-mode-toggle" className="text-[10px] font-bold text-gray-700 cursor-pointer select-none">
                Show Difference (R - L)
              </label>
            </div>

            {showDiff && (
              <div className="flex flex-col gap-2.5 border-t border-gray-100/50 pt-2.5 w-full">
                {/* Colormap Selector */}
                <div className="flex flex-col gap-0.5 w-full">
                  <label htmlFor="diff-colormap" className="text-[8px] font-bold text-gray-400 uppercase tracking-wider">
                    Colormap
                  </label>
                  <select
                    id="diff-colormap"
                    value={colormap}
                    onChange={(e) => setColormap(e.target.value as any)}
                    className="text-[10px] font-semibold text-gray-700 bg-gray-50 border border-gray-200 rounded-md px-2 py-0.5 focus:ring-1 focus:ring-amber-500 focus:outline-none cursor-pointer w-full"
                  >
                    <option value="red-green">Red / Green (Loss / Gain)</option>
                    <option value="red-blue">Red / Blue (Loss / Gain)</option>
                    <option value="grayscale">Grayscale Difference</option>
                  </select>
                </div>

                {/* Noise Filter Slider */}
                <div className="flex flex-col gap-0.5 w-full">
                  <div className="flex justify-between text-[8px] font-bold text-gray-400 uppercase tracking-wider">
                    <span>Noise Filter</span>
                    <span className="text-gray-600 font-mono font-bold">{threshold}</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="50"
                    value={threshold}
                    onChange={(e) => setThreshold(Number(e.target.value))}
                    className="w-full h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-amber-600"
                  />
                </div>

                {/* Sensitivity Slider */}
                <div className="flex flex-col gap-0.5 w-full">
                  <div className="flex justify-between text-[8px] font-bold text-gray-400 uppercase tracking-wider">
                    <span>Sensitivity</span>
                    <span className="text-gray-600 font-mono font-bold">{sensitivity}</span>
                  </div>
                  <input
                    type="range"
                    min="50"
                    max="250"
                    value={sensitivity}
                    onChange={(e) => setSensitivity(Number(e.target.value))}
                    className="w-full h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-amber-600"
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Exit Button */}
      <button
        onClick={onExit}
        className={cn(
          buttonVariants({ variant: 'outline', size: 'sm' }),
          "absolute top-4 right-4 z-50 bg-white/95 backdrop-blur-sm shadow-md hover:bg-gray-100 gap-1.5"
        )}
      >
        <X className="w-4 h-4" />
        <span>Exit Compare</span>
      </button>
    </div>
  )
}
