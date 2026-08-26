import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

// Logs in through the actual, visible /auth/login form -- never by seeding
// a session cookie/localStorage directly. Every E2E scenario in this suite
// that needs an authenticated session goes through this real form.
export async function loginAs(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/auth/login')
  await page.getByPlaceholder('te@example.com').click()
  await page.getByPlaceholder('te@example.com').fill(email)
  await page.getByPlaceholder('••••••••').click()
  await page.getByPlaceholder('••••••••').fill(password)
  await page.getByRole('button', { name: 'Belépés' }).click()
  await expect(page.getByText('Bejelentkezett felhasználó')).toBeVisible({ timeout: 15_000 })
}

export async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Kilépés' }).click()
  // Generous timeout: the local dev server's known, pre-existing Next.js 15
  // `cookies()` sync-dynamic-apis dev warning (unrelated to this feature,
  // present throughout the app) occasionally slows the post-signOut
  // redirect past a tight default timeout without ever actually failing it.
  await expect(page).toHaveURL(/\/auth\/login/, { timeout: 15_000 })
}
