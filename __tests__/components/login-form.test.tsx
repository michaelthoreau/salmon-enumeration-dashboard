// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import LoginForm from '@/app/(auth)/login/login-form'

// Mock the server action — useActionState just holds initial null state
vi.mock('@/app/actions/auth', () => ({
  requestOtp: vi.fn(),
  verifyOtpAction: vi.fn(),
}))

// next/navigation used by any Link inside shadcn inputs
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
}))

describe('LoginForm', () => {
  it('renders the Sign in heading', () => {
    render(<LoginForm />)
    expect(screen.getByRole('heading', { name: /sign in/i })).toBeDefined()
  })

  it('renders the email input', () => {
    render(<LoginForm />)
    expect(screen.getByLabelText(/email address/i)).toBeDefined()
  })

  it('renders the Send code button', () => {
    render(<LoginForm />)
    expect(screen.getByRole('button', { name: /send code/i })).toBeDefined()
  })

  it('pre-fills the email input when prefilledEmail is provided', () => {
    render(<LoginForm prefilledEmail="alice@example.com" />)
    const input = screen.getByLabelText(/email address/i) as HTMLInputElement
    expect(input.defaultValue).toBe('alice@example.com')
  })

  it('does NOT render the quick-sign-in button when suggestedEmail is absent', () => {
    render(<LoginForm />)
    expect(screen.queryByText(/continue as/i)).toBeNull()
  })

  it('renders the quick-sign-in button when suggestedEmail is provided', () => {
    render(<LoginForm suggestedEmail="bob@example.com" />)
    expect(screen.getByText(/continue as/i)).toBeDefined()
    expect(screen.getByText('bob@example.com')).toBeDefined()
  })

  it('renders the "or use a different email" divider when suggestedEmail is set', () => {
    render(<LoginForm suggestedEmail="bob@example.com" />)
    expect(screen.getByText(/or use a different email/i)).toBeDefined()
  })

  it('does not render an error alert initially', () => {
    render(<LoginForm />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
