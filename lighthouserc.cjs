let chromePath
try {
  // Dynamically resolve Chromium binary path installed by Playwright
  const playwright = require('playwright')
  chromePath = playwright.chromium.executablePath()
} catch (err) {
  console.warn('[LHCI Config] Could not resolve Playwright chromium executable path:', err.message)
}

const targetBaseUrl = process.env.E2E_BASE_URL || 'http://localhost:3199'
const isFastLocal = !process.env.CI
// PR runs in CI audit a representative core set once per URL (~5 min). The
// full set with 2 runs per URL took ~14 min; it still runs on manual
// workflow_dispatch (the E2E workflow sets LHCI_FULL) and locally.
const isFull = !process.env.CI || !!process.env.LHCI_FULL

// Public pages + the main authenticated surfaces. Legal pages share one static
// layout, and admin/secondary settings pages are low-traffic. `/`, `/login` and
// `/join` are full-audit only: the puppeteer script logs in first, so in CI
// they redirect into the app and just re-audit an authenticated page.
const corePaths = [
  '/pricing',
  '/help-center',
  '/dashboard',
  '/calendar',
  '/chat',
  '/activities',
  '/nutrition',
  '/performance',
  '/settings'
]
const extraPaths = [
  '/',
  '/login',
  '/join',
  '/works-with',
  '/terms',
  '/privacy',
  '/cookies',
  '/reports',
  '/data',
  '/profile/settings',
  '/admin',
  '/admin/stats/llm',
  '/admin/system-messages'
]
const auditPaths = isFull ? [...corePaths, ...extraPaths] : corePaths

module.exports = {
  ci: {
    collect: {
      url: process.env.LHCI_URL ? [process.env.LHCI_URL] : auditPaths.map((p) => `${targetBaseUrl}${p}`),
      puppeteerScript: './e2e/scripts/lhci-auth.cjs',
      puppeteerLaunchOptions: {
        args: [
          '--no-sandbox',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--headless=new',
          '--no-pings',
          '--disable-background-networking'
        ]
      },
      // 2 runs for statistical stability on full CI audits; 1 elsewhere.
      numberOfRuns: isFull && !isFastLocal ? 2 : 1,
      ...(chromePath || process.env.CHROME_PATH
        ? { chromePath: process.env.CHROME_PATH || chromePath }
        : {}),
      settings: {
        preset: 'desktop',
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
        skipAudits: ['full-page-screenshot', 'font-size'],
        logLevel: process.env.LHCI_LOG_LEVEL || (isFastLocal ? 'info' : 'silent'),
        disableStorageReset: true,
        // App pages hold a live realtime connection and never go network-idle,
        // so every audit sat out the default 45s maxWaitForLoad ("page loaded
        // too slowly") although they paint in <1s. 15s still leaves wide
        // margin for a genuinely slow page.
        maxWaitForLoad: 15000,
        pauseAfterFulfillMs: 1000,
        pauseAfterLoadMs: 1000,
        networkQuietThresholdMs: 1000,
        // Disable artificial CPU/network throttling during local dev runs for 3x speedup
        ...(isFastLocal
          ? {
              throttlingMethod: 'provided',
              throttling: { rttMs: 0, throughputKbps: 0, cpuSlowdownMultiplier: 1 }
            }
          : {})
      }
    },
    assert: {
      assertions: {
        'categories:accessibility': ['error', { minScore: 0.80 }],
        'categories:performance': ['warn', { minScore: 0.40 }],
        'categories:best-practices': ['warn', { minScore: 0.75 }],
        'categories:seo': ['warn', { minScore: 0.75 }]
      }
    },
    upload: {
      target: 'temporary-public-storage'
    }
  }
}
