import Link from 'next/link'

function Code({ children }: { children: string }) {
  return (
    <pre className="bg-gray-900 text-gray-100 rounded-lg p-4 text-xs font-mono overflow-x-auto whitespace-pre">
      {children}
    </pre>
  )
}

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-semibold text-gray-900 mt-10 mb-3">{children}</h2>
}

function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="text-base font-medium text-gray-800 mt-6 mb-2">{children}</h3>
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

export default function ApiDocsPage() {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://your-domain.com'

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <Link href="/admin" className="text-sm text-gray-500 hover:text-gray-900">← Admin</Link>
      </div>

      <h1 className="text-2xl font-semibold text-gray-900 mb-2">API Reference</h1>
      <P>Programmatically create flight plans, log flights, and upload files using API keys.</P>

      <H2>Authentication</H2>
      <P>All API endpoints require a Bearer token in the <code className="font-mono bg-gray-100 px-1 rounded">Authorization</code> header. Generate keys at <Link href="/admin/api-keys" className="text-blue-600 hover:underline">Admin → API Keys</Link>.</P>
      <Code>{`Authorization: Bearer sockeye_<your-key>`}</Code>

      <H2>Endpoints</H2>

      {/* Projects */}
      <H3><Pill color="blue">GET</Pill> {' '}/api/v1/projects</H3>
      <P>List all active projects.</P>
      <Code>{`curl ${base}/api/v1/projects \\
  -H "Authorization: Bearer sockeye_<key>"`}</Code>
      <P>Response:</P>
      <Code>{`[
  { "id": "uuid", "name": "river-survey", "description": "...", "timezone": "America/Vancouver" }
]`}</Code>

      {/* Flight plans */}
      <H3><Pill color="blue">GET</Pill> {' '}/api/v1/flight-plans?projectId=</H3>
      <P>List active flight plans for a project.</P>
      <Code>{`curl "${base}/api/v1/flight-plans?projectId=<projectId>" \\
  -H "Authorization: Bearer sockeye_<key>"`}</Code>

      <H3><Pill color="green">POST</Pill> {' '}/api/v1/flight-plans</H3>
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

      {/* Flights */}
      <H3><Pill color="blue">GET</Pill> {' '}/api/v1/flights?flightPlanId=</H3>
      <P>List active flights for a flight plan.</P>
      <Code>{`curl "${base}/api/v1/flights?flightPlanId=<flightPlanId>" \\
  -H "Authorization: Bearer sockeye_<key>"`}</Code>

      <H3><Pill color="green">POST</Pill> {' '}/api/v1/flights</H3>
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

      {/* Upload */}
      <H3><Pill color="green">POST</Pill> {' '}/api/v1/upload</H3>
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

      <H2>Workflow example</H2>
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

      <H2>Error responses</H2>
      <P>All errors return JSON with an <code className="font-mono bg-gray-100 px-1 rounded">error</code> field:</P>
      <Code>{`{ "error": "Unauthorized" }          // 401 — missing or revoked key
{ "error": "Flight not found" }      // 404
{ "error": "flightId is required" }  // 400`}</Code>
    </div>
  )
}
