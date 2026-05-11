'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

function prettify(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// Matches: /projects/[projectId]/flight-plans/[flightPlanId]/flights/[flightId]
const SEGMENTS = [
  { pattern: /^\/projects$/, crumbs: () => [{ label: 'Projects', href: '/projects' }] },
  {
    pattern: /^\/projects\/([^/]+)\/flight-plans$/,
    crumbs: (m: RegExpMatchArray) => [
      { label: 'Projects', href: '/projects' },
      { label: prettify(m[1]), href: `/projects/${m[1]}/flight-plans` },
    ],
  },
  {
    pattern: /^\/projects\/([^/]+)\/flight-plans\/([^/]+)\/flights$/,
    crumbs: (m: RegExpMatchArray) => [
      { label: 'Projects', href: '/projects' },
      { label: prettify(m[1]), href: `/projects/${m[1]}/flight-plans` },
      { label: prettify(m[2]), href: `/projects/${m[1]}/flight-plans/${m[2]}/flights` },
    ],
  },
  {
    pattern: /^\/projects\/([^/]+)\/flight-plans\/([^/]+)\/flights\/([^/]+)$/,
    crumbs: (m: RegExpMatchArray) => [
      { label: 'Projects', href: '/projects' },
      { label: prettify(m[1]), href: `/projects/${m[1]}/flight-plans` },
      { label: prettify(m[2]), href: `/projects/${m[1]}/flight-plans/${m[2]}/flights` },
      { label: 'Flight', href: null },
    ],
  },
]

export default function NavBreadcrumb() {
  const pathname = usePathname()

  for (const { pattern, crumbs } of SEGMENTS) {
    const match = pathname.match(pattern)
    if (match) {
      const items = crumbs(match as RegExpMatchArray)
      return (
        <nav className="flex items-center gap-1.5 text-sm">
          {items.map((item, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-gray-300">/</span>}
              {item.href ? (
                <Link href={item.href} className="text-gray-600 hover:text-gray-900 transition-colors">
                  {item.label}
                </Link>
              ) : (
                <span className="text-gray-400">{item.label}</span>
              )}
            </span>
          ))}
        </nav>
      )
    }
  }

  // Default: just show Projects link
  return (
    <Link href="/projects" className="text-gray-600 hover:text-gray-900 text-sm">
      Projects
    </Link>
  )
}
