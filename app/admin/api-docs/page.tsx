'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { TryPanel } from './try-panel'

function Code({ children }: { children: string }) {
  return (
    <pre className="bg-gray-900 text-gray-100 rounded-lg p-4 text-xs font-mono overflow-x-auto whitespace-pre">
      {children}
    </pre>
  )
}

function SectionH2({ id, children }: { id: string; children: React.ReactNode }) {
  return <h2 id={id} className="text-lg font-semibold text-gray-900 mt-10 mb-3 scroll-mt-20">{children}</h2>
}

function SectionH3({ id, children }: { id: string; children: React.ReactNode }) {
  return <h3 id={id} className="text-base font-medium text-gray-800 mt-6 mb-2 scroll-mt-20">{children}</h3>
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-gray-600 mb-3">{children}</p>
}

function Pill({ children, color = 'blue' }: { children: string; color?: 'blue' | 'green' | 'yellow' }) {
  const cls = {
    blue: 'bg-blue-100 text-blue-700',
    green: 'bg-green-100 text-green-700',
    yellow: 'bg-yellow-100 text-yellow-700',
  }[color]
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono font-medium ${cls}`}>{children}</span>
}

const NAV_SECTIONS = [
  { id: 'authentication', label: 'Authentication' },
  {
    label: 'Projects',
    children: [
      { id: 'get-projects', label: '/projects', method: 'GET' },
    ],
  },
  {
    label: 'Flight Plans',
    children: [
      { id: 'get-flight-plans', label: '/flight-plans', method: 'GET' },
      { id: 'post-flight-plans', label: '/flight-plans', method: 'POST' },
    ],
  },
  {
    label: 'Flights',
    children: [
      { id: 'get-flights', label: '/flights', method: 'GET' },
      { id: 'post-flights', label: '/flights', method: 'POST' },
    ],
  },
  {
    label: 'Upload',
    children: [
      { id: 'post-upload', label: '/upload', method: 'POST' },
    ],
  },
  { id: 'workflow', label: 'Workflow' },
  { id: 'errors', label: 'Errors' },
]

const ALL_IDS = [
  'authentication',
  'get-projects',
  'get-flight-plans', 'post-flight-plans',
  'get-flights', 'post-flights',
  'post-upload',
  'workflow', 'errors',
]

const METHOD_COLORS: Record<string, string> = {
  GET: 'text-blue-600 bg-blue-50',
  POST: 'text-green-600 bg-green-50',
}

export default function ApiDocsPage() {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://your-domain.com'
  const [apiKey, setApiKey] = useState('')
  const [activeId, setActiveId] = useState('authentication')

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveId(entry.target.id)
        }
      },
      { rootMargin: '-10% 0px -80% 0px' },
    )
    ALL_IDS.forEach(id => {
      const el = document.getElementById(id)
      if (el) observer.observe(el)
    })
    return () => observer.disconnect()
  }, [])

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <Link href="/admin" className="text-sm text-gray-500 hover:text-gray-900">← Admin</Link>
      </div>

      <div className="flex gap-10">
        {/* Sidebar */}
        <aside className="hidden md:block w-48 shrink-0">
          <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pr-2 space-y-5">
            {NAV_SECTIONS.map((section) => {
              if ('children' in section) {
                return (
                  <div key={section.label}>
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">{section.label}</p>
                    <ul className="space-y-0.5">
                      {section.children ? section.children.map((item) => (
                        <li key={item.id}>
                          <a
                            href={`#${item.id}`}
                            className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors ${
                              activeId === item.id
                                ? 'bg-blue-50 text-blue-700 font-medium'
                                : 'text-gray-500 hover:text-gray-900 hover:bg-gray-50'
                            }`}
                          >
                            <span className={`font-mono text-[10px] font-semibold px-1 py-0.5 rounded ${METHOD_COLORS[item.method]}`}>
                              {item.method}
                            </span>
                            <span className="font-mono truncate">{item.label}</span>
                          </a>
                        </li>
                      )) : null}
                    </ul>
                  </div>
                )
              }
              return (
                <div key={section.id}>
                  <a
                    href={`#${section.id}`}
                    className={`block px-2 py-1 rounded text-xs font-medium transition-colors ${
                      activeId === section.id
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-gray-500 hover:text-gray-900 hover:bg-gray-50'
                    }`}
                  >
                    {section.label}
                  </a>
                </div>
              )
            })}
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 min-w-0">
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">API Reference</h1>
          <P>Programmatically create flight plans, log flights, and upload files using API keys.</P>

          {/* Authentication */}
          <SectionH2 id="authentication">Authentication</SectionH2>
          <P>All API endpoints require a Bearer token in the <code className="font-mono bg-gray-100 px-1 rounded">Authorization</code> header. Generate keys at <Link href="/admin/api-keys" className="text-blue-600 hover:underline">Admin → API Keys</Link>.</P>
          <Code>{`Authorization: Bearer sockeye_<your-key>`}</Code>
          <div className="mt-3 mb-6 flex items-center gap-2">
            <label className="text-xs text-gray-500 font-medium shrink-0">Your API key</label>
            <input
              type="password"
              className="flex-1 max-w-xs border border-gray-300 rounded px-2 py-1 text-xs font-mono bg-white"
              placeholder="sockeye_…"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
            />
            {apiKey && <span className="text-xs text-green-600 font-medium">✓ set</span>}
          </div>

          {/* Projects */}
          <SectionH3 id="get-projects"><Pill color="blue">GET</Pill>{' '}/api/v1/projects</SectionH3>
          <P>List all active projects.</P>
          <Code>{`curl ${base}/api/v1/projects \\
  -H "Authorization: Bearer sockeye_<key>"`}</Code>
          <P>Response:</P>
          <Code>{`[
  { "id": "uuid", "name": "river-survey", "description": "...", "timezone": "America/Vancouver" }
]`}</Code>
          <TryPanel method="GET" path="/api/v1/projects" apiKey={apiKey} />

          {/* Flight Plans */}
          <SectionH3 id="get-flight-plans"><Pill color="blue">GET</Pill>{' '}/api/v1/flight-plans?projectId=</SectionH3>
          <P>List active flight plans for a project.</P>
          <Code>{`curl "${base}/api/v1/flight-plans?projectId=<projectId>" \\
  -H "Authorization: Bearer sockeye_<key>"`}</Code>
          <TryPanel method="GET" path="/api/v1/flight-plans" apiKey={apiKey} defaultParams={{ projectId: '' }} />

          <SectionH3 id="post-flight-plans"><Pill color="green">POST</Pill>{' '}/api/v1/flight-plans</SectionH3>
          <P>Create a new flight plan. The name is slugified automatically.</P>
          <Code>{`curl -X POST ${base}/api/v1/flight-plans \\
  -H "Authorization: Bearer sockeye_<key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectId": "<projectId>",
    "name": "morning-run",
    "description": "Optional description"
  }'`}</Code>
          <P>Response <Pill color="yellow">201</Pill>:</P>
          <Code>{`{ "id": "uuid", "name": "morning-run" }`}</Code>
          <TryPanel
            method="POST"
            path="/api/v1/flight-plans"
            apiKey={apiKey}
            defaultBody={`{\n  "projectId": "<projectId>",\n  "name": "morning-run",\n  "description": "Optional description"\n}`}
          />

          {/* Flights */}
          <SectionH3 id="get-flights"><Pill color="blue">GET</Pill>{' '}/api/v1/flights?flightPlanId=</SectionH3>
          <P>List active flights for a flight plan.</P>
          <Code>{`curl "${base}/api/v1/flights?flightPlanId=<flightPlanId>" \\
  -H "Authorization: Bearer sockeye_<key>"`}</Code>
          <TryPanel method="GET" path="/api/v1/flights" apiKey={apiKey} defaultParams={{ flightPlanId: '' }} />

          <SectionH3 id="post-flights"><Pill color="green">POST</Pill>{' '}/api/v1/flights</SectionH3>
          <P>Log a new flight. The timestamp should be in <code className="font-mono bg-gray-100 px-1 rounded">YYYY-MM-DDTHH:mm</code> format using the project's configured timezone, or an ISO 8601 UTC string.</P>
          <Code>{`curl -X POST ${base}/api/v1/flights \\
  -H "Authorization: Bearer sockeye_<key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "flightPlanId": "<flightPlanId>",
    "timestamp": "2026-05-10T09:30",
    "notes": "Clear skies, 12kt wind"
  }'`}</Code>
          <P>Response <Pill color="yellow">201</Pill>:</P>
          <Code>{`{ "id": "uuid", "timestamp": "2026-05-10T16:30:00.000Z" }`}</Code>
          <TryPanel
            method="POST"
            path="/api/v1/flights"
            apiKey={apiKey}
            defaultBody={`{\n  "flightPlanId": "<flightPlanId>",\n  "timestamp": "2026-05-24T09:30",\n  "notes": "Clear skies, 12kt wind"\n}`}
          />

          {/* Upload */}
          <SectionH3 id="post-upload"><Pill color="green">POST</Pill>{' '}/api/v1/upload</SectionH3>
          <P>Request presigned S3 POST URLs for one or more files, then upload directly to S3. Maximum 500 files per batch.</P>
          <Code>{`# Step 1 — get presigned URLs
curl -X POST ${base}/api/v1/upload \\
  -H "Authorization: Bearer sockeye_<key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "flightId": "<flightId>",
    "files": [
      { "name": "image001.jpg", "type": "image/jpeg", "size": 4200000 }
    ]
  }'`}</Code>
          <TryPanel
            method="POST"
            path="/api/v1/upload"
            apiKey={apiKey}
            defaultBody={`{\n  "flightId": "<flightId>",\n  "files": [\n    { "name": "image001.jpg", "type": "image/jpeg", "size": 4200000 }\n  ]\n}`}
          />
          <P>Response:</P>
          <Code>{`{
  "uploads": [
    {
      "name": "image001.jpg",
      "url": "https://s3.amazonaws.com/<bucket>",
      "fields": { "key": "...", "Policy": "...", ... }
    }
  ]
}`}</Code>
          <Code>{`# Step 2 — POST each file directly to S3
curl -X POST "<url>" \\
  -F "key=<fields.key>" \\
  -F "Policy=<fields.Policy>" \\
  -F "X-Amz-Signature=<fields.X-Amz-Signature>" \\
  ... (all other fields) \\
  -F "file=@image001.jpg"   # 'file' must be the last field`}</Code>

          {/* Workflow */}
          <SectionH2 id="workflow">Workflow example</SectionH2>
          <P>A typical end-to-end script looks like this:</P>
          <Code>{`#!/usr/bin/env bash
KEY="sockeye_<your-key>"
BASE="${base}"

# 1. Get the project ID
PROJECT_ID=$(curl -s "$BASE/api/v1/projects" \\
  -H "Authorization: Bearer $KEY" | jq -r '.[0].id')

# 2. Create a flight plan
FP_ID=$(curl -s -X POST "$BASE/api/v1/flight-plans" \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"projectId":"'$PROJECT_ID'","name":"survey-a"}' | jq -r '.id')

# 3. Log a flight
F_ID=$(curl -s -X POST "$BASE/api/v1/flights" \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"flightPlanId":"'$FP_ID'","timestamp":"2026-05-10T09:30"}' | jq -r '.id')

# 4. Get presigned URLs
UPLOADS=$(curl -s -X POST "$BASE/api/v1/upload" \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"flightId":"'$F_ID'","files":[{"name":"img.jpg","type":"image/jpeg","size":100000}]}')

# 5. Upload to S3
URL=$(echo $UPLOADS | jq -r '.uploads[0].url')
# (build -F flags from .uploads[0].fields, then append -F "file=@img.jpg")`}</Code>

          {/* Errors */}
          <SectionH2 id="errors">Error responses</SectionH2>
          <P>All errors return JSON with an <code className="font-mono bg-gray-100 px-1 rounded">error</code> field:</P>
          <Code>{`{ "error": "Unauthorized" }          // 401 — missing or revoked key
{ "error": "Flight not found" }      // 404
{ "error": "flightId is required" }  // 400`}</Code>
        </main>
      </div>
    </div>
  )
}

