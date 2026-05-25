'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, useRef, useEffect } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { EditProjectButton } from '@/app/projects/project-actions'
import type { projects } from '@/lib/schema'
import type { InferSelectModel } from 'drizzle-orm'

type Project = InferSelectModel<typeof projects>

interface Props {
  projectId: string
  projectName: string
  projectDescription: string | null
  isAdmin: boolean
  project: Project
}

const TABS = [
  { label: 'Flights',  href: (id: string) => `/projects/${id}/flight-plans`, match: (p: string, id: string) => p.startsWith(`/projects/${id}/flight-plans`) },
  { label: 'Dataset',  href: (id: string) => `/projects/${id}/dataset`,       match: (p: string, id: string) => p.startsWith(`/projects/${id}/dataset`) },
  { label: 'Labeling', href: (id: string) => `/projects/${id}/labeling`,      match: (p: string, id: string) => p.startsWith(`/projects/${id}/labeling`) },
]

export default function ProjectNav({ projectId, projectName, projectDescription, isAdmin, project }: Props) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

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
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center h-11 gap-3">

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

      </div>
    </div>
  )
}

