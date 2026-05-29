'use client'

import { useState } from 'react'
import Link from 'next/link'
import { LayoutListIcon, MapIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import OrthoMap from './[flightId]/ortho-map'
import EditFlightButton from './[flightId]/edit-flight-button'
import { DeleteFlightButton } from './flight-actions'
import type { OdmTaskStatus } from '@/lib/schema'
import type { InferSelectModel } from 'drizzle-orm'
import type { flights } from '@/lib/schema'

type Flight = InferSelectModel<typeof flights>

export interface FlightRow {
  flight: Flight
  formattedTime: string
  localTimestamp: string
  imageCount: number
  taskStatus: OdmTaskStatus | null
  outputKey: string | null
}

interface Props {
  rows: FlightRow[]
  projectId: string
  flightPlanId: string
  timezone: string
  canWrite: boolean
}

function ProcessingBadge({ status }: { status: OdmTaskStatus | null }) {
  if (status === 'completed') return <span className="text-green-600 font-medium">Done</span>
  if (status === 'running') return <span className="text-blue-500">Running</span>
  if (status === 'queued' || status === 'uploading') return <span className="text-amber-500">Queued</span>
  if (status === 'failed') return <span className="text-red-500">Failed</span>
  if (status === 'canceled') return <span className="text-gray-400">Canceled</span>
  return <span className="text-gray-300">—</span>
}

export default function FlightsView({ rows, projectId, flightPlanId, timezone, canWrite }: Props) {
  const [view, setView] = useState<'list' | 'map'>('list')

  // Default to most recent flight that has an orthophoto
  const firstWithOrtho = rows.find((r) => r.outputKey)
  const [selectedId, setSelectedId] = useState<string | null>(firstWithOrtho?.flight.id ?? null)

  const selected = rows.find((r) => r.flight.id === selectedId)
  // Chronological order for the timeline (oldest → newest, left → right)
  const timelineRows = [...rows].reverse()

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900">
          Flights <span className="text-sm font-normal text-gray-500">({rows.length})</span>
        </h2>
        <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
          <button
            type="button"
            onClick={() => setView('list')}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 transition-colors',
              view === 'list' ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50',
            )}
          >
            <LayoutListIcon className="w-3.5 h-3.5" />
            List
          </button>
          <button
            type="button"
            onClick={() => setView('map')}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 border-l border-gray-200 transition-colors',
              view === 'map' ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50',
            )}
          >
            <MapIcon className="w-3.5 h-3.5" />
            Map
          </button>
        </div>
      </div>

      {/* ── List view ────────────────────────────────────────────────────── */}
      {view === 'list' && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {rows.length === 0 ? (
            <p className="text-sm text-gray-500 p-6">No flights logged yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Timestamp</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Notes</th>
                  <th className="text-right px-6 py-3 font-medium text-gray-600">Images</th>
                  <th className="text-center px-6 py-3 font-medium text-gray-600">Processing</th>
                  <th className="text-center px-6 py-3 font-medium text-gray-600">Orthophoto</th>
                  {canWrite && <th className="px-6 py-3" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map(({ flight, formattedTime, localTimestamp, imageCount, taskStatus, outputKey }) => (
                  <tr key={flight.id}>
                    <td className="px-6 py-3 text-xs text-gray-700">
                      <Link
                        href={`/projects/${projectId}/flight-plans/${flightPlanId}/flights/${flight.id}`}
                        className="font-medium text-blue-600 hover:underline"
                      >
                        {formattedTime}
                      </Link>
                    </td>
                    <td className="px-6 py-3 text-gray-500">{flight.notes ?? '—'}</td>
                    <td className="px-6 py-3 text-right tabular-nums text-gray-700">
                      {imageCount > 0 ? imageCount : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-6 py-3 text-center text-sm">
                      <ProcessingBadge status={taskStatus} />
                    </td>
                    <td className="px-6 py-3 text-center text-sm">
                      {outputKey
                        ? <span className="text-green-600">✓</span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                    {canWrite && (
                      <td className="px-6 py-3 text-right flex items-center justify-end gap-1">
                        <EditFlightButton
                          flightId={flight.id}
                          projectId={projectId}
                          flightPlanId={flightPlanId}
                          timezone={timezone}
                          localTimestamp={localTimestamp}
                          currentNotes={flight.notes}
                        />
                        <DeleteFlightButton
                          flight={flight}
                          projectId={projectId}
                          flightPlanId={flightPlanId}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Map view ─────────────────────────────────────────────────────── */}
      {view === 'map' && (
        <div className="space-y-2">
          {/* Map area */}
          {selected?.outputKey ? (
            <OrthoMap outputKey={selected.outputKey} />
          ) : (
            <div className="relative w-full h-96 rounded-xl overflow-hidden border border-gray-200 bg-gray-100 flex items-center justify-center">
              <p className="text-sm text-gray-400">
                {rows.length === 0
                  ? 'No flights logged yet.'
                  : 'Select a flight with an orthophoto from the timeline below.'}
              </p>
            </div>
          )}

          {/* Timeline */}
          <div className="flex items-center gap-2 p-3 overflow-x-auto rounded-xl border border-gray-200 bg-white">
            {timelineRows.length === 0 ? (
              <p className="text-xs text-gray-400 px-2">No flights yet.</p>
            ) : (
              timelineRows.map(({ flight, formattedTime, outputKey }) => {
                const hasOrtho = !!outputKey
                const isSelected = flight.id === selectedId
                return (
                  <button
                    key={flight.id}
                    type="button"
                    disabled={!hasOrtho}
                    onClick={() => setSelectedId(flight.id)}
                    className={cn(
                      'flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap',
                      !hasOrtho && 'text-gray-300 cursor-default',
                      hasOrtho && !isSelected && 'bg-white border border-gray-200 text-gray-600 hover:border-gray-400',
                      hasOrtho && isSelected && 'bg-gray-900 text-white',
                    )}
                    title={!hasOrtho ? 'No orthophoto' : formattedTime}
                  >
                    {formattedTime}
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </section>
  )
}
