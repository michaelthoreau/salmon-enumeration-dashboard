'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { MapPin } from 'lucide-react'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'
import { DeleteFlightPlanButton, EditFlightPlanButton } from './flight-plan-actions'

interface PlanEntry {
  id: string
  name: string
  displayName: string | null
  description: string | null
  createdAt: string
  locationTags: { name: string; color: string }[]
}

interface Props {
  plans: PlanEntry[]
  projectId: string
  isAdmin: boolean
  availableLocationTags: string[]
}

export default function FlightPlansView({ plans, projectId, isAdmin, availableLocationTags }: Props) {
  const [locationFilter, setLocationFilter] = useState<string>('')

  const filtered = useMemo(() => {
    if (!locationFilter) return plans
    return plans.filter((p) => p.locationTags.some((t) => t.name === locationFilter))
  }, [plans, locationFilter])

  return (
    <div>
      {availableLocationTags.length > 0 && (
        <div className="mb-3 flex items-center gap-2">
          <div className="relative">
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <select
              value={locationFilter}
              onChange={(e) => setLocationFilter(e.target.value)}
              className="pl-9 pr-8 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent appearance-none bg-white cursor-pointer"
            >
              <option value="">All locations</option>
              {availableLocationTags.map((tag) => (
                <option key={tag} value={tag}>{tag}</option>
              ))}
            </select>
          </div>
          {locationFilter && (
            <span className="text-xs text-gray-500">
              {filtered.length} of {plans.length} routes
            </span>
          )}
        </div>
      )}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {filtered.length === 0 ? (
          <p className="text-sm text-gray-500 p-6">
            {plans.length === 0 ? 'No flight routes yet.' : 'No routes match the selected location.'}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-6 py-3 font-medium text-gray-600">Name</th>
                <th className="text-left px-6 py-3 font-medium text-gray-600">Description</th>
                <th className="text-left px-6 py-3 font-medium text-gray-600">Location</th>
                <th className="text-left px-6 py-3 font-medium text-gray-600">Created</th>
                {isAdmin && <th className="px-6 py-3" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((plan) => (
                <tr key={plan.id}>
                  <td className="px-6 py-3">
                    <Link
                      href={`/projects/${projectId}/flight-plans/${plan.id}/flights?from=list`}
                      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                    >
                      {plan.displayName || plan.name}
                    </Link>
                  </td>
                  <td className="px-6 py-3 text-gray-500">
                    {plan.description ?? '—'}
                  </td>
                  <td className="px-6 py-3">
                    {plan.locationTags.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {plan.locationTags.map((tag) => (
                          <span
                            key={tag.name}
                            className="inline-flex items-center rounded px-1.5 py-px text-[10px] font-medium border"
                            style={{
                              backgroundColor: tag.color + '22',
                              borderColor: tag.color + '66',
                              color: tag.color,
                            }}
                          >
                            {tag.name}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-6 py-3 text-gray-500">
                    {plan.createdAt}
                  </td>
                  {isAdmin && (
                    <td className="px-6 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <EditFlightPlanButton plan={plan} projectId={projectId} />
                        <DeleteFlightPlanButton plan={plan as any} projectId={projectId} />
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
