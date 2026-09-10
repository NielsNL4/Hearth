import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5185', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev -- --port 5185 --strictPort',
    cwd: './apps/web',
    url: 'http://127.0.0.1:5185',
    reuseExistingServer: false,
    env: {
      PLAYWRIGHT: '1',
      VITE_SUPABASE_URL: 'http://127.0.0.1:59999',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_browser_test_only',
      VITE_MULTIPLAYER_URL: 'ws://127.0.0.1:59997',
      VITE_ASSET_API_URL: 'http://127.0.0.1:59998',
    },
  },
});
