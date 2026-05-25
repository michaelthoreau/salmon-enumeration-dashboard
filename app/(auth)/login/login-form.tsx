'use client'

import { useActionState } from 'react'
import { requestOtp } from '@/app/actions/auth'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'

interface LoginFormProps {
  suggestedEmail?: string  // from cookie — shown as a quick-sign-in button
  prefilledEmail?: string  // from URL param — pre-fills the email input
}

export default function LoginForm({ suggestedEmail, prefilledEmail }: LoginFormProps) {
  const [state, action, pending] = useActionState(requestOtp, null)

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8">
      <h1 className="text-2xl font-semibold text-gray-900 mb-1">Sign in</h1>
      <p className="text-sm text-gray-500 mb-6">
        Enter your email and we&apos;ll send you a one-time code.
      </p>

      {/* Quick sign-in button for returning users */}
      {suggestedEmail && (
        <>
          <form action={action} className="mb-4">
            <input type="hidden" name="email" value={suggestedEmail} />
            <button
              type="submit"
              disabled={pending}
              className="w-full flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm hover:bg-gray-100 transition-colors text-left"
            >
              <span className="flex-1 min-w-0">
                <span className="block text-xs text-gray-500 mb-0.5">Continue as</span>
                <span className="font-medium text-gray-900 truncate block">{suggestedEmail}</span>
              </span>
              <span className="text-gray-400 shrink-0">&rarr;</span>
            </button>
          </form>

          <div className="relative my-5">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-200" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-white px-2 text-xs text-gray-400">or use a different email</span>
            </div>
          </div>
        </>
      )}

      {/* Email input form */}
      <form action={action} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email address</Label>
          <Input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            autoFocus={!suggestedEmail}
            defaultValue={prefilledEmail}
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
  )
}
