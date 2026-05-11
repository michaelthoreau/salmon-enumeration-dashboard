'use client'

import { useActionState, useEffect, useState } from 'react'
import { createApiKey, revokeApiKey } from '@/app/actions/api-keys'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'

interface ApiKeyRow {
  id: string
  name: string
  createdAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
}

export function CreateApiKeyButton() {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState(createApiKey, null)
  const [revealed, setRevealed] = useState<string | null>(null)

  useEffect(() => {
    if (state?.newKey) {
      setRevealed(state.newKey)
      setOpen(false)
    }
  }, [state])

  return (
    <>
      <Button onClick={() => setOpen(true)}>New API key</Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton>
          <DialogHeader><DialogTitle>Create API key</DialogTitle></DialogHeader>
          <form action={action} className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="key-name">Name</Label>
              <Input id="key-name" name="name" required placeholder="e.g. Field laptop" />
            </div>
            {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={pending}>{pending ? 'Creating…' : 'Create'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* One-time key reveal */}
      <Dialog open={!!revealed} onOpenChange={() => setRevealed(null)}>
        <DialogContent showCloseButton>
          <DialogHeader><DialogTitle>Save your API key</DialogTitle></DialogHeader>
          <p className="text-sm text-gray-600">This key will not be shown again. Copy it now.</p>
          <div className="rounded-lg bg-gray-100 p-3 font-mono text-sm break-all select-all">{revealed}</div>
          <DialogFooter>
            <Button onClick={() => { navigator.clipboard.writeText(revealed ?? ''); setRevealed(null) }}>
              Copy &amp; close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function RevokeApiKeyButton({ keyId, keyName }: { keyId: string; keyName: string }) {
  const [open, setOpen] = useState(false)
  const [, action, pending] = useActionState(revokeApiKey, null)

  return (
    <>
      <Button variant="ghost" size="xs" className="text-destructive hover:text-destructive" onClick={() => setOpen(true)}>
        Revoke
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton>
          <DialogHeader><DialogTitle>Revoke API key?</DialogTitle></DialogHeader>
          <p className="text-sm text-gray-600">
            Revoking <strong>{keyName}</strong> will immediately block all requests using it.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <form action={action}>
              <input type="hidden" name="id" value={keyId} />
              <Button type="submit" disabled={pending} variant="ghost" className="text-destructive hover:text-destructive">
                {pending ? '…' : 'Revoke'}
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
