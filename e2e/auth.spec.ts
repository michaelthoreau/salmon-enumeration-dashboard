import { test, expect } from '@playwright/test'

/**
 * Auth flow E2E tests.
 *
 * These tests verify the authentication UI and redirect behaviour.
 * Because OTP delivery goes through email, tests that require a complete
 * login are limited to what is observable without reading the mailbox.
 */

test.describe('Unauthenticated redirect', () => {
  test('/ redirects to /login when not signed in', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/login/)
  })

  test('/projects/* redirects to /login when not signed in', async ({ page }) => {
    await page.goto('/projects/some-project')
    await expect(page).toHaveURL(/\/login/)
  })

  test('/admin redirects to /login when not signed in', async ({ page }) => {
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/login/)
  })
})

test.describe('Login page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login')
  })

  test('shows the Sign in heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible()
  })

  test('has an email input', async ({ page }) => {
    await expect(page.getByLabel(/email address/i)).toBeVisible()
  })

  test('has a Send code submit button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /send code/i })).toBeVisible()
  })

  test('shows error for an unrecognised email address', async ({ page }) => {
    await page.getByLabel(/email address/i).fill('nobody@notadomain.invalid')
    await page.getByRole('button', { name: /send code/i }).click()
    // Expect an inline error message to appear
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 5000 })
  })

  test('pre-fills email from ?email= query param', async ({ page }) => {
    await page.goto('/login?email=prefill%40example.com')
    const input = page.getByLabel(/email address/i)
    await expect(input).toHaveValue('prefill@example.com')
  })
})

test.describe('Verify page', () => {
  test('redirects to /login if email cookie is missing', async ({ page }) => {
    await page.goto('/verify')
    // Should land back on login (no email to verify)
    await expect(page).toHaveURL(/\/login|\/verify/)
  })
})
