'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState, useRef, useEffect, useTransition } from 'react'
import { ChevronDownIcon, RefreshCw, Check } from 'lucide-react'
import { EditProjectButton } from '@/app/projects/project-actions'
import type { projects } from '@/lib/schema'
import type { InferSelectModel } from 'drizzle-orm'
import { Button } from '@/components/ui/button'
import { syncProjectActiveTasks } from '@/app/actions/projects'


type Project = InferSelectModel<typeof projects>

interface Props {
  projectId: string
  projectName: string
  projectDescription: string | null
  isAdmin: boolean
  project: Project
}

const TABS = [
  { label: 'Flights',     href: (id: string) => `/projects/${id}`,             match: (p: string, id: string) => p === `/projects/${id}` },
  { label: 'Flight routes',  href: (id: string) => `/projects/${id}/flight-plans`, match: (p: string, id: string) => p.startsWith(`/projects/${id}/flight-plans`) },
  { label: 'Dataset',  href: (id: string) => `/projects/${id}/dataset`,       match: (p: string, id: string) => p.startsWith(`/projects/${id}/dataset`) },
  { label: 'Labeling', href: (id: string) => `/projects/${id}/labeling`,      match: (p: string, id: string) => p.startsWith(`/projects/${id}/labeling`) },
]

export default function ProjectNav({ projectId, projectName, projectDescription, isAdmin, project }: Props) {
  const pathname = usePathname()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [syncSuccess, setSyncSuccess] = useState(false)
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const handleRefresh = () => {
    startTransition(async () => {
      const res = await syncProjectActiveTasks(projectId)
      if (res?.success) {
        setSyncSuccess(true)
        setTimeout(() => setSyncSuccess(false), 2000)
        router.refresh()
      }
    })
  }

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="bg-white border-b border-gray-200">
      <div className="w-full px-6 flex items-center h-11 gap-3">

        {/* Project breadcrumb dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setOpen(v => !v)}
            className="flex items-center gap-1 text-sm font-medium text-gray-700 hover:text-gray-900 transition-colors"
          >
            {projectName}
            <ChevronDownIcon className="w-3.5 h-3.5 text-gray-400" />
          </button>

          {open && (
            <div className="absolute left-0 top-full mt-1 w-52 rounded-lg border border-gray-200 bg-white shadow-lg z-50 py-1">
              <Link
                href="/"
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
                onClick={() => setOpen(false)}
              >
                ← All projects
              </Link>
              {projectDescription && (
                <p className="px-3 py-1.5 text-xs text-gray-400 border-t border-gray-100">{projectDescription}</p>
              )}
              {isAdmin && (
                <div className="border-t border-gray-100 pt-1 px-2 pb-1" onClick={() => setOpen(false)}>
                  <EditProjectButton project={project} label="Edit project" variant="ghost" size="xs" />
                </div>
              )}
            </div>
          )}
        </div>

        <span className="text-gray-200 select-none">/</span>

        {/* Tabs */}
        <nav className="flex items-center h-full">
          {TABS.map(tab => {
            const active = tab.match(pathname, projectId)
            return (
              <Link
                key={tab.label}
                href={tab.href(projectId)}
                className={`flex items-center h-full px-3 text-sm font-medium border-b-2 transition-colors ${
                  active
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300'
                }`}
              >
                {tab.label}
              </Link>
            )
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={isPending}
            className={`flex items-center gap-1.5 transition-all text-xs font-semibold px-2.5 h-7 rounded-md border ${
              syncSuccess
                ? 'border-green-200 bg-green-50/70 text-green-700 hover:bg-green-50/70 hover:text-green-700'
                : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 hover:text-gray-900 active:bg-gray-100'
            }`}
          >
            {syncSuccess ? (
              <Check className="w-3.5 h-3.5 text-green-600 stroke-[3px]" />
            ) : (
              <RefreshCw
                className={`w-3.5 h-3.5 text-gray-400 transition-transform ${
                  isPending ? 'animate-spin' : ''
                }`}
              />
            )}
            <span>{syncSuccess ? 'Synced' : isPending ? 'Refreshing...' : 'Refresh'}</span>
          </Button>
        </div>

      </div>
    </div>
  )
}

