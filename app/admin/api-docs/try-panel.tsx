'use client'

import { useState } from 'react'

interface TryPanelProps {
  method: 'GET' | 'POST'
  path: string
  apiKey: string
  defaultParams?: Record<string, string>
  defaultBody?: string
}

export function TryPanel({ method, path, apiKey, defaultParams, defaultBody }: TryPanelProps) {
  const [open, setOpen] = useState(false)
  const [params, setParams] = useState<Record<string, string>>(defaultParams ?? {})
  const [body, setBody] = useState(defaultBody ?? '')
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState<{ status: number; body: string } | null>(null)
  const [reqError, setReqError] = useState<string | null>(null)

  async function send() {
    setLoading(true)
    setResponse(null)
    setReqError(null)
    try {
      let url = path
      if (method === 'GET') {
        const filled = Object.entries(params).filter(([, v]) => v.trim() !== '')
        if (filled.length > 0) url += '?' + new URLSearchParams(filled).toString()
      }
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(method === 'POST' && body ? { body } : {}),
      })
      let text = await res.text()
      try { text = JSON.stringify(JSON.parse(text), null, 2) } catch { /* leave as-is */ }
      setResponse({ status: res.status, body: text })
    } catch (e) {
      setReqError(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mt-2 mb-4">
      <button
        onClick={() => setOpen(o => !o)}
        className="text-xs text-blue-600 hover:text-blue-800 font-medium"
      >
        {open ? '▾ Hide' : '▸ Try it'}
      </button>
      {open && (
        <div className="mt-2 border border-gray-200 rounded-lg p-4 bg-gray-50 space-y-3">
          {method === 'GET' && Object.keys(params).length > 0 && (
            <div className="space-y-2">
              {Object.entries(params).map(([key, val]) => (
                <div key={key} className="flex items-center gap-2">
                  <label className="w-32 text-xs text-gray-500 font-mono shrink-0">{key}</label>
                  <input
                    className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs font-mono bg-white"
                    value={val}
                    onChange={e => setParams(p => ({ ...p, [key]: e.target.value }))}
                    placeholder={`<${key}>`}
                  />
                </div>
              ))}
            </div>
          )}
          {method === 'POST' && (
            <div>
              <label className="text-xs text-gray-500 block mb-1">Request body (JSON)</label>
              <textarea
                className="w-full border border-gray-300 rounded px-2 py-1 text-xs font-mono bg-white h-32 resize-y"
                value={body}
                onChange={e => setBody(e.target.value)}
              />
            </div>
          )}
          {!apiKey && (
            <p className="text-xs text-amber-600">Enter your API key above to send requests.</p>
          )}
          <button
            onClick={send}
            disabled={loading || !apiKey}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-1.5 rounded"
          >
            {loading ? 'Sending…' : `Send ${method}`}
          </button>
          {reqError && <p className="text-xs text-red-600">{reqError}</p>}
          {response && (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${response.status < 300 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                  {response.status}
                </span>
                <span className="text-xs text-gray-500">Response</span>
              </div>
              <pre className="bg-gray-900 text-gray-100 rounded p-3 text-xs font-mono overflow-x-auto whitespace-pre">
                {response.body}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
