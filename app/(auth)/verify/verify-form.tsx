'use client'

import { useActionState } from 'react'
import { verifyOtpAction } from '@/app/actions/auth'
import Link from 'next/link'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'

interface VerifyFormProps {
  email: string
}

export default function VerifyForm({ email }: VerifyFormProps) {
  const [state, action, pending] = useActionState(verifyOtpAction, null)

  return (
    <div className="w-full max-w-sm">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">Check your email</h1>
        <p className="text-sm text-gray-500 mb-6">
          We sent a 6-digit code to <strong className="text-gray-700">{email}</strong>. It
          expires in 10 minutes.
        </p>

        <form action={action} className="space-y-4">
          <input type="hidden" name="email" value={email} />

          <div className="space-y-1.5">
            <Label htmlFor="code">One-time code</Label>
            <Input
              id="code"
              name="code"
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              required
              autoFocus
              placeholder="123456"
              className="tracking-widest text-center font-mono"
            />
          </div>

          {state?.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}

          <Button type="submit" disabled={pending} className="w-full">
            {pending ? 'Verifying…' : 'Verify code'}
          </Button>
        </form>

        <p className="mt-4 text-center text-sm text-gray-500">
          Wrong email?{' '}
          <Link href="/login" className="text-blue-600 hover:underline">
            Go back
          </Link>
        </p>
      </div>
    </div>
  )
}
