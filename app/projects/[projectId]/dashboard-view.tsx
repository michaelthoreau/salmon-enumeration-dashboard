'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { MapPin, Map, Calendar, Eye, EyeOff, Settings, Sparkles, Navigation, ArrowRight, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button, buttonVariants } from '@/components/ui/button'
import { toggleFlightPlanDashboardVisibility } from '@/app/actions/flight-plans'
import { EditFlightPlanButton } from './flight-plans/flight-plan-actions'
import 'maplibre-gl/dist/maplibre-gl.css'

interface DashboardPlan {
  id: string
  name: string
  originalName: string
  displayName: string | null
  description: string | null
  showOnDashboard: boolean
  location: string | null
  flightDates: string[]
  flightCount: number
}

interface Props {
  projectId: string
  projectName: string
  plans: DashboardPlan[]
  isAdmin: boolean
}

function getBounds(plans: DashboardPlan[]): [number, number, number, number] | null {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
  let hasCoords = false

  for (const plan of plans) {
    if (!plan.location || !plan.showOnDashboard) continue
    try {
      const geom = JSON.parse(plan.location)
      if (geom.type === 'Point') {
        const [lng, lat] = geom.coordinates
        minLng = Math.min(minLng, lng)
        minLat = Math.min(minLat, lat)
        maxLng = Math.max(maxLng, lng)
        maxLat = Math.max(maxLat, lat)
        hasCoords = true
      } else if (geom.type === 'Polygon') {
        for (const ring of geom.coordinates) {
          for (const [lng, lat] of ring) {
            minLng = Math.min(minLng, lng)
            minLat = Math.min(minLat, lat)
            maxLng = Math.max(maxLng, lng)
            maxLat = Math.max(maxLat, lat)
            hasCoords = true
          }
        }
      }
    } catch (err) {
      console.error('Error parsing bounds for plan:', plan.id, err)
    }
  }

  return hasCoords ? [minLng, minLat, maxLng, maxLat] : null
}

export default function ProjectDashboardView({ projectId, projectName, plans, isAdmin }: Props) {
  const router = useRouter()
  const mapContainerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any | null>(null)
  const [mapReady, setMapReady] = useState(false)

  const [isCustomizing, setIsCustomizing] = useState(false)
  const [hoveredPlanId, setHoveredPlanId] = useState<string | null>(null)
  const [isUpdating, setIsUpdating] = useState<string | null>(null)

  // Filter plans based on customization mode
  const visiblePlans = plans.filter((p) => p.showOnDashboard)
  const displayPlans = isCustomizing ? plans : visiblePlans

  // Build GeoJSON features for map
  const geojsonFeatures = plans
    .filter((p) => p.showOnDashboard && p.location)
    .map((p) => {
      try {
        const geom = JSON.parse(p.location!)
        return {
          type: 'Feature',
          geometry: geom,
          properties: {
            id: p.id,
            name: p.name,
            description: p.description ?? '',
            dates: p.flightDates.join(', ') || 'No flights logged',
          },
        }
      } catch (e) {
        return null
      }
    })
    .filter(Boolean)

  const geojson = {
    type: 'FeatureCollection' as const,
    features: geojsonFeatures as any[],
  }

  // ── Initialize Map ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainerRef.current) return
    let cancelled = false

    async function initMap() {
      try {
        const maplibre = (await import('maplibre-gl')).default
        if (cancelled || !mapContainerRef.current) return

        const map = new maplibre.Map({
          container: mapContainerRef.current,
          style: 'https://tiles.openfreemap.org/styles/liberty',
          zoom: 2,
          center: [-152, 61], // Center Alaska by default
          attributionControl: false,
        })

        mapRef.current = map
        map.addControl(new maplibre.AttributionControl({ compact: true }))
        map.addControl(new maplibre.NavigationControl(), 'top-right')

        map.on('load', () => {
          if (cancelled) return
          setMapReady(true)

          // Add source for flight plans
          map.addSource('flight-plans-source', {
            type: 'geojson',
            data: geojson,
          })

          // Add fill layer for polygons
          map.addLayer({
            id: 'flight-plans-fill',
            type: 'fill',
            source: 'flight-plans-source',
            paint: {
              'fill-color': '#3b82f6',
              'fill-opacity': 0.15,
            },
            filter: ['==', '$type', 'Polygon'],
          })

          // Add outline layer for polygons
          map.addLayer({
            id: 'flight-plans-line',
            type: 'line',
            source: 'flight-plans-source',
            paint: {
              'line-color': '#2563eb',
              'line-width': 2,
            },
            filter: ['in', '$type', 'LineString', 'Polygon'],
          })

          // Add circle layer for points (pins)
          map.addLayer({
            id: 'flight-plans-point',
            type: 'circle',
            source: 'flight-plans-source',
            paint: {
              'circle-color': '#3b82f6',
              'circle-radius': 8,
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
            },
            filter: ['==', '$type', 'Point'],
          })

          // Add highlight layers
          map.addLayer({
            id: 'flight-plans-highlight-line',
            type: 'line',
            source: 'flight-plans-source',
            paint: {
              'line-color': '#1d4ed8',
              'line-width': 4,
            },
            filter: ['==', 'id', ''],
          })

          map.addLayer({
            id: 'flight-plans-highlight-point',
            type: 'circle',
            source: 'flight-plans-source',
            paint: {
              'circle-color': '#1d4ed8',
              'circle-radius': 11,
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
            },
            filter: ['all', ['==', 'id', ''], ['==', '$type', 'Point']],
          })

          // Zoom to show all features
          const bounds = getBounds(plans)
          if (bounds) {
            map.fitBounds(bounds, { padding: 50, maxZoom: 15, animate: false })
          }

          // Register click handlers for popups
          const clickLayers = ['flight-plans-fill', 'flight-plans-point']
          clickLayers.forEach((layerId) => {
            map.on('click', layerId, (e: any) => {
              const feature = e.features[0]
              const { id, name, description, dates } = feature.properties

              const popupHtml = `
                <div style="font-family: ui-sans-serif, system-ui, sans-serif; padding: 12px; max-width: 240px;">
                  <h3 style="font-weight: 700; font-size: 14px; color: #111827; margin: 0;">${name}</h3>
                  ${description ? `<p style="font-size: 12px; color: #6b7280; margin-top: 4px; margin-bottom: 0;">${description}</p>` : ''}
                  <p style="font-size: 11px; color: #374151; margin-top: 8px; margin-bottom: 2px;"><strong>Logged Flights:</strong></p>
                  <p style="font-size: 10px; color: #6b7280; margin: 0; line-height: 1.4;">${dates}</p>
                  <a href="/projects/${projectId}/flight-plans/${id}/flights" style="display: inline-block; margin-top: 12px; font-size: 11px; font-weight: 600; color: #2563eb; text-decoration: none; transition: color 0.15s ease-in-out;">
                    View logged flights →
                  </a>
                </div>
              `

              new maplibre.Popup()
                .setLngLat(e.lngLat)
                .setHTML(popupHtml)
                .addTo(map)
            })

            map.on('mouseenter', layerId, () => {
              map.getCanvas().style.cursor = 'pointer'
            })
            map.on('mouseleave', layerId, () => {
              map.getCanvas().style.cursor = ''
            })
          })
        })
      } catch (err) {
        console.error('Failed to init dashboard map:', err)
      }
    }

    initMap()

    return () => {
      cancelled = true
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Update Map Data when plans update ──────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || !mapReady) return
    const source = mapRef.current.getSource('flight-plans-source')
    if (source) {
      source.setData(geojson)
    }

    const bounds = getBounds(plans)
    if (bounds) {
      mapRef.current.fitBounds(bounds, { padding: 50, maxZoom: 15, animate: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans, mapReady])

  // ── Update Highlights on hover ─────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || !mapReady) return
    const map = mapRef.current

    if (map.getLayer('flight-plans-highlight-line')) {
      map.setFilter('flight-plans-highlight-line', ['==', 'id', hoveredPlanId || ''])
    }
    if (map.getLayer('flight-plans-highlight-point')) {
      map.setFilter('flight-plans-highlight-point', ['all', ['==', 'id', hoveredPlanId || ''], ['==', '$type', 'Point']])
    }
  }, [hoveredPlanId, mapReady])

  // ── Toggle dashboard visibility action ─────────────────────────────────────
  async function handleToggleVisibility(planId: string, currentVal: boolean) {
    setIsUpdating(planId)
    try {
      await toggleFlightPlanDashboardVisibility(planId, !currentVal)
      router.refresh()
    } catch (err) {
      console.error('Failed to update dashboard visibility:', err)
    } finally {
      setIsUpdating(null)
    }
  }

  // Handle clicking flight plan cards in list to zoom on map
  function handleFocusPlan(plan: DashboardPlan) {
    if (!mapRef.current || !mapReady || !plan.location) return
    try {
      const geom = JSON.parse(plan.location)
      if (geom.type === 'Point') {
        mapRef.current.flyTo({ center: geom.coordinates, zoom: 14 })
      } else if (geom.type === 'Polygon') {
        // Compute bounding box for this polygon specifically
        let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
        for (const ring of geom.coordinates) {
          for (const [lng, lat] of ring) {
            minLng = Math.min(minLng, lng)
            minLat = Math.min(minLat, lat)
            maxLng = Math.max(maxLng, lng)
            maxLat = Math.max(maxLat, lat)
          }
        }
        mapRef.current.fitBounds([minLng, minLat, maxLng, maxLat], { padding: 40, maxZoom: 15 })
      }
    } catch (e) {
      console.error(e)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="flex items-center justify-between pb-4 border-b border-gray-200">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-gray-900 leading-tight">
              {projectName} Dashboard
            </h1>
          </div>
          <p className="text-sm text-gray-500 mt-1.5 leading-relaxed">
            Overview of customized flight plan locations, logged flight frequencies, and schedules.
          </p>
        </div>

        {isAdmin && (
          <Button
            size="sm"
            variant={isCustomizing ? 'default' : 'outline'}
            className={cn('gap-2 text-xs font-semibold h-9 shadow-sm transition-all', {
              'bg-blue-600 hover:bg-blue-700 text-white': isCustomizing,
            })}
            onClick={() => setIsCustomizing((prev) => !prev)}
          >
            <Settings className="w-4 h-4" />
            <span>{isCustomizing ? 'Done Customizing' : 'Customize Dashboard'}</span>
          </Button>
        )}
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left Side: Flight Plan List */}
        <section className="lg:col-span-5 flex flex-col gap-4 min-h-[500px]">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wider text-gray-400 select-none">
              {isCustomizing ? 'All Flight Plans' : 'Monitored Flight Plans'} ({displayPlans.length})
            </h2>
            {visiblePlans.length === 0 && !isCustomizing && (
              <span className="text-[10px] bg-amber-50 text-amber-600 border border-amber-200 rounded px-2 py-0.5 font-medium select-none">
                No active plans
              </span>
            )}
          </div>

          <div className="space-y-3 overflow-y-auto no-scrollbar flex-1 max-h-[600px] pr-1">
            {displayPlans.length === 0 ? (
              <div className="text-center py-16 text-gray-400 bg-white rounded-2xl border border-gray-200/60 p-6 shadow-sm border-dashed">
                <span className="text-3xl block mb-2">🗺️</span>
                <p className="text-sm font-semibold text-gray-600">No flight plans visible.</p>
                <p className="text-xs text-gray-500 mt-1 max-w-xs mx-auto">
                  {isAdmin
                    ? 'Click "Customize Dashboard" above to check which plans should display on this screen.'
                    : 'Check back later once the system administrator selects plans to display.'}
                </p>
              </div>
            ) : (
              displayPlans.map((plan) => {
                const hasLoc = !!plan.location
                return (
                  <div
                    key={plan.id}
                    className={cn(
                      'group bg-white rounded-2xl border p-5 transition-all shadow-sm relative flex flex-col gap-3.5 hover:shadow-md',
                      plan.showOnDashboard ? 'border-gray-200/80' : 'border-gray-200/40 opacity-60 bg-gray-50/50',
                      hoveredPlanId === plan.id && 'border-blue-300 ring-1 ring-blue-300/40'
                    )}
                    onMouseEnter={() => setHoveredPlanId(plan.id)}
                    onMouseLeave={() => setHoveredPlanId(null)}
                  >
                    {/* Inline Visibility Toggle (Admin) */}
                    {isCustomizing && (
                      <button
                        onClick={() => handleToggleVisibility(plan.id, plan.showOnDashboard)}
                        disabled={isUpdating === plan.id}
                        className={cn(
                          'absolute top-4 right-4 p-1.5 rounded-lg border transition-colors shadow-sm',
                          plan.showOnDashboard
                            ? 'bg-blue-50 border-blue-200 text-blue-600 hover:bg-blue-100'
                            : 'bg-white border-gray-200 text-gray-400 hover:bg-gray-50 hover:text-gray-600'
                        )}
                        title={plan.showOnDashboard ? 'Hide from Dashboard' : 'Show on Dashboard'}
                      >
                        {plan.showOnDashboard ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                      </button>
                    )}

                    {/* Edit Flight Plan button (Admin, absolute top-right) */}
                    {isAdmin && (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className={cn('absolute top-4', isCustomizing ? 'right-14' : 'right-4')}
                      >
                        <EditFlightPlanButton
                          plan={{
                            id: plan.id,
                            name: plan.originalName,
                            displayName: plan.displayName,
                            description: plan.description,
                          }}
                          projectId={projectId}
                          label={<Pencil className="w-4 h-4" />}
                          variant="ghost"
                          size="xs"
                          className={cn(
                            'rounded-lg border transition-colors shadow-sm p-1.5 bg-white border-gray-200 text-gray-400 hover:bg-gray-50 hover:text-gray-650'
                          )}
                        />
                      </div>
                    )}

                    {/* Flight Plan Content */}
                    <div className={cn('pr-0', { 'pr-12': isAdmin, 'pr-20': isAdmin && isCustomizing })}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link
                          href={`/projects/${projectId}/flight-plans/${plan.id}/flights`}
                          className="text-base font-semibold text-gray-900 hover:text-blue-600 transition-colors leading-tight font-medium"
                        >
                          {plan.name}
                        </Link>
                        {hasLoc && (
                          <button
                            onClick={() => handleFocusPlan(plan)}
                            className="p-1 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                            title="Zoom to location on map"
                          >
                            <Navigation className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      {plan.description && (
                        <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                          {plan.description}
                        </p>
                      )}
                    </div>

                    {/* Flight Dates and Summary */}
                    <div className="border-t border-gray-100 pt-3.5 flex items-center justify-between gap-4">
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex items-center text-xs text-gray-500 font-medium">
                          <span className="flex items-center gap-1">
                            <Calendar className="w-3.5 h-3.5 text-gray-400" />
                            <span>Logged Dates ({plan.flightCount})</span>
                          </span>
                        </div>

                        {plan.flightDates.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {plan.flightDates.slice(0, 3).map((date, idx) => (
                              <span
                                key={idx}
                                className="inline-flex items-center rounded-md bg-gray-50 border border-gray-200/60 px-2 py-0.5 text-[10px] text-gray-600 font-medium font-mono"
                              >
                                {date}
                              </span>
                            ))}
                            {plan.flightDates.length > 3 && (
                              <span className="inline-flex items-center rounded-md bg-gray-50 border border-gray-200/60 px-2 py-0.5 text-[10px] text-gray-500 font-medium font-mono">
                                +{plan.flightDates.length - 3} more
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-[10px] text-gray-400 italic font-medium leading-none block">
                            No flights logged yet.
                          </span>
                        )}
                      </div>

                      <Link
                        href={`/projects/${projectId}/flight-plans/${plan.id}/flights`}
                        className={cn(
                          buttonVariants({ variant: 'outline', size: 'sm' }),
                          "text-xs font-semibold gap-1.5 h-8 flex-shrink-0"
                        )}
                      >
                        <span>Open</span>
                        <ArrowRight className="w-3.5 h-3.5 text-gray-500 group-hover:translate-x-0.5 transition-transform" />
                      </Link>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </section>

        {/* Right Side: Map Area */}
        <section className="lg:col-span-7 flex flex-col min-h-[500px]">
          <div className="flex-1 rounded-2xl border border-gray-200 overflow-hidden shadow-sm relative min-h-[480px]">
            <div ref={mapContainerRef} className="w-full h-full absolute inset-0" />

            {/* Map Info Overlay Banner */}
            <div className="absolute bottom-4 left-4 z-40 bg-white/95 backdrop-blur-sm px-3 py-2 rounded-xl shadow-md border border-gray-200/60 flex items-center gap-2 pointer-events-none select-none max-w-sm">
              <Sparkles className="w-4 h-4 text-yellow-500 animate-pulse flex-shrink-0" />
              <p className="text-[10px] font-medium text-gray-600 leading-snug">
                Click shapes on the map to inspect individual flight plan summaries and logged calendars.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
