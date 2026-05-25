import { test, expect } from '@playwright/test'

/**
 * Navigation / routing E2E tests.
 *
 * Verifies that pages exist, have correct titles, and that route protection
 * works as expected — without requiring a live user session.
 */

test.describe('Public pages', () => {
  test('login page loads and has correct title/heading', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible()
  })
})

test.describe('Protected route redirects', () => {
  const protectedRoutes = ['/', '/admin', '/admin/api-keys', '/admin/api-docs']

  for (const route of protectedRoutes) {
    test(`${route} redirects to /login when unauthenticated`, async ({ page }) => {
      await page.goto(route)
      await expect(page).toHaveURL(/\/login/, { timeout: 5000 })
    })
  }
})

test.describe('404 and error handling', () => {
  test('a completely unknown route does not cause a server error', async ({ page }) => {
    const res = await page.goto('/this-route-does-not-exist-at-all')
    // Auth middleware redirects unauthenticated requests to /login before
    // Next.js can return a 404, so we just assert there is no 5xx error.
    expect(res?.status()).toBeLessThan(500)
  })
})
