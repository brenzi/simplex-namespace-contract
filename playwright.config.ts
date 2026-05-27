import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './test/e2e',
  testMatch: '*.spec.ts',
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: [['html', { open: 'never' }]],
  projects: [
    {
      name: 'simplex',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
})
