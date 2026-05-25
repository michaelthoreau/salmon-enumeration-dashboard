// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import VerifyForm from '@/app/(auth)/verify/verify-form'

vi.mock('@/app/actions/auth', () => ({
  requestOtp: vi.fn(),
  verifyOtpAction: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
}))

describe('VerifyForm', () => {
  it('renders the "Check your email" heading', () => {
    render(<VerifyForm email="user@example.com" />)
    expect(screen.getByRole('heading', { name: /check your email/i })).toBeDefined()
  })

  it('displays the recipient email address', () => {
    render(<VerifyForm email="user@example.com" />)
    expect(screen.getByText('user@example.com')).toBeDefined()
  })

  it('renders the code input', () => {
    render(<VerifyForm email="user@example.com" />)
    expect(screen.getByLabelText(/one-time code/i)).toBeDefined()
  })

  it('renders the Verify code button', () => {
    render(<VerifyForm email="user@example.com" />)
    expect(screen.getByRole('button', { name: /verify code/i })).toBeDefined()
  })

  it('code input has pattern and maxLength constraints', () => {
    render(<VerifyForm email="user@example.com" />)
    const input = screen.getByLabelText(/one-time code/i) as HTMLInputElement
    expect(input.maxLength).toBe(6)
    expect(input.pattern).toBe('\\d{6}')
  })

  it('shows auto-sign-in message when prefilledCode is provided', () => {
    render(<VerifyForm email="user@example.com" prefilledCode="123456" />)
    expect(screen.getByText(/signing you in as/i)).toBeDefined()
  })

  it('pre-fills the code input when prefilledCode is given', () => {
    render(<VerifyForm email="user@example.com" prefilledCode="654321" />)
    const input = screen.getByLabelText(/one-time code/i) as HTMLInputElement
    expect(input.defaultValue).toBe('654321')
  })

  it('shows the regular "sent a code" message when prefilledCode is absent', () => {
    render(<VerifyForm email="user@example.com" />)
    expect(screen.getByText(/we sent a 6-digit code/i)).toBeDefined()
  })

  it('renders a "Wrong email?" back link', () => {
    render(<VerifyForm email="user@example.com" />)
    expect(screen.getByRole('link', { name: /go back/i })).toBeDefined()
  })

  it('does not render an error alert initially', () => {
    render(<VerifyForm email="user@example.com" />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
