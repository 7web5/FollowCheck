import { defineConfig, devices } from '@playwright/test';

const PORT = 4174;
// Set BASE_URL to test a deployment instead of the local server.
const BASE_URL = process.env.BASE_URL;

export default defineConfig({
  testDir: 'tests',
  testMatch: /.*\.e2e\.mjs$/,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL ?? `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 14'] } },
  ],
  webServer: BASE_URL
    ? undefined
    : {
        command: `node tools/serve.mjs ${PORT}`,
        url: `http://localhost:${PORT}/`,
        reuseExistingServer: !process.env.CI,
      },
});
