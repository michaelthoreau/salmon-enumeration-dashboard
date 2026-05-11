'use client'

import { useActionState } from 'react'
import { requestOtp } from '@/app/actions/auth'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'

interface LoginFormProps {
  defaultEmail?: string
}

export default function LoginForm({ defaultEmail }: LoginFormProps) {
  const [state, action, pending] = useActionState(requestOtp, null)

  return (
    <div className="w-full max-w-sm">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">Sign in</h1>
        <p className="text-sm text-gray-500 mb-6">
          Enter your email and we&apos;ll send you a one-time code.
        </p>

        <form action={action} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email address</Label>
            <Input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              autoFocus
              defaultValue={defaultEmail}
              placeholder="you@example.com"
            />
          </div>

          {state?.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}

          <Button type="submit" disabled={pending} className="w-full">
            {pending ? 'Sending code…' : 'Send code'}
          </Button>
        </form>
      </div>
    </div>
  )
}
