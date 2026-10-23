import pkg from './package.json'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const TERMS = [
  'negative-split',
  'tempo',
  'threshold',
  'vo2max',
  'aerobic',
  'lactate',
  'cadence',
  'drafting',
  'bonk',
  'hydration',
  'endurance',
  'ultra',
  'interval',
  'fartlek',
  'base',
  'peak',
  'recovery',
  'zone2',
  'taper',
  'hillrepeat'
]

const ANIMALS = [
  'falcon',
  'cheetah',
  'wolf',
  'gazelle',
  'ibex',
  'husky',
  'orca',
  'condor',
  'marlin',
  'albatross',
  'caribou',
  'puma',
  'camel'
]

const sanitizeSlugPart = (input: string) =>
  input
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

const makeSeededRng = (seed: string) => {
  let state = createHash('sha256').update(seed).digest().readUInt32BE(0) >>> 0
  return (min: number, max: number) => {
    state = (1664525 * state + 1013904223) >>> 0
    const range = max - min + 1
    return min + (state % range)
  }
}

const pickDeterministic = (list: string[], rng: (min: number, max: number) => number) =>
  sanitizeSlugPart(list[rng(0, list.length - 1)] as string)

const getBuildCodename = (seed: string) => {
  if (process.env.NUXT_PUBLIC_BUILD_CODENAME) {
    return sanitizeSlugPart(process.env.NUXT_PUBLIC_BUILD_CODENAME)
  }

  const rng = makeSeededRng(seed)
  const term = pickDeterministic(TERMS, rng)
  const animal = pickDeterministic(ANIMALS, rng)
  return `${term}-${animal}`
}

const getGitCommitHash = () => {
  if (process.env.NUXT_PUBLIC_COMMIT_HASH) {
    return process.env.NUXT_PUBLIC_COMMIT_HASH
  }
  if (process.env.COMMIT_SHA) {
    return process.env.COMMIT_SHA.substring(0, 7)
  }
  if (process.env.REVISION_ID) {
    return process.env.REVISION_ID.substring(0, 7)
  }
  if (process.env.SHORT_SHA) {
    return process.env.SHORT_SHA
  }
  if (process.env.BUILD_ID) {
    return process.env.BUILD_ID
  }
  return process.env.NODE_ENV === 'development' ? 'dev' : 'unknown'
}

const commitHash = getGitCommitHash()
const date = new Date()
const buildDate = date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'
const buildCodenameSeed =
  process.env.NUXT_PUBLIC_BUILD_CODENAME_SEED ||
  (commitHash !== 'unknown' ? `${pkg.version}:${commitHash}` : `${pkg.version}:${buildDate}`)
const buildCodename = getBuildCodename(buildCodenameSeed)
const buildVersion = `v${pkg.version}+${buildDate}.${commitHash}.${buildCodename}`

const sentryRelease = `${pkg.name}@${pkg.version}+${commitHash}`
const sentryEnabled = process.env.NODE_ENV === 'production' || process.env.SENTRY_ENABLED === 'true'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  ignore: ['examples/**', 'coverage/**', 'backups/**'],
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  app: {
    head: {
      titleTemplate: '%s - Coach Watts',
      title: 'Coach Watts',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        {
          name: 'description',
          content: 'AI-powered endurance coaching platform that adapts to your training.'
        },
        { name: 'apple-mobile-web-app-title', content: 'Coach Watts' },
        { name: 'application-name', content: 'Coach Watts' },
        { property: 'og:site_name', content: 'Coach Watts' },
        { property: 'og:type', content: 'website' },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:site', content: '@coachwatts' },
        { name: 'mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'default' }
      ],
      link: [
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
        { rel: 'manifest', href: '/manifest.json' }
      ],
      script: [
        {
          innerHTML: `
            (function() {
              window.addEventListener('error', function(event) {
                var errorText = event.message || '';
                if (
                  errorText.includes('Importing a module script failed') ||
                  errorText.includes('Failed to fetch dynamically imported module') ||
                  errorText.includes('loading chunk')
                ) {
                  var now = Date.now();
                  var lastReload = sessionStorage.getItem('chunk-error-reload');
                  if (lastReload && (now - parseInt(lastReload) < 10000)) return;
                  sessionStorage.setItem('chunk-error-reload', now.toString());
                  var url = new URL(window.location.href);
                  url.searchParams.set('reload', now.toString());
                  window.location.href = url.toString();
                }
              }, true);
            })();
          `.replace(/\s+/g, ' '),
          type: 'text/javascript'
        }
      ]
    }
  },

  modules: [
    '@nuxt/ui',
    '@nuxt/content',
    '@stefanobartoletti/nuxt-social-share',
    '@sidebase/nuxt-auth',
    '@nuxtjs/mdc',
    '@pinia/nuxt',
    'nuxt-gtag',
    'nuxt-api-shield',
    '@sentry/nuxt/module',
    '@nuxt/eslint',
    '@vue-email/nuxt'
  ],

  // Always ship the real nuxt-gtag client plugin. Docker/CI builds do not have
  // NUXT_PUBLIC_GTAG_ID at build time; Dokploy injects it at runtime. Gating
  // `enabled` on the build-time env installed mocks forever and killed tracking.
  gtag: {
    enabled: true,
    id: process.env.NUXT_PUBLIC_GTAG_ID || '',
    tags: [
      ...(process.env.NUXT_PUBLIC_GA_MEASUREMENT_ID
        ? [process.env.NUXT_PUBLIC_GA_MEASUREMENT_ID]
        : ['G-M3CJW4RW5S'])
    ]
  },

  vueEmail: {
    baseUrl: process.env.NUXT_PUBLIC_SITE_URL || 'https://app.coachwatts.com',
    emailsDir: 'app/emails'
  },

  colorMode: {
    preference: 'system',
    fallback: 'light'
  },

  socialShare: {
    baseUrl: process.env.NUXT_PUBLIC_SITE_URL || 'http://localhost:3099'
  },

  nitro: {
    compressPublicAssets: true,
    routeRules: {
      '/media/**': { headers: { 'cache-control': 'public, max-age=31536000, immutable' } },
      '/images/**': { headers: { 'cache-control': 'public, max-age=31536000, immutable' } },
      '/_nuxt/**': { headers: { 'cache-control': 'public, max-age=31536000, immutable' } }
    },
    prerender: {
      crawlLinks: false,
      routes: []
    },
    hooks: {
      'prerender:routes'(routes) {
        routes.clear()
      }
    },
    experimental: {
      openAPI: process.env.SOURCEMAP !== 'false',
      websocket: true,
      tasks: true,
      asyncContext: true
    },
    openAPI:
      process.env.SOURCEMAP === 'false'
        ? (undefined as any)
        : {
            production: 'runtime',
            route: '/_openapi.json',
            meta: {
              title: 'Coach Watts API',
              description: 'AI-powered endurance coaching platform API',
              version: pkg.version
            },
            ui: {
              scalar: {
                route: '/_docs/scalar',
                theme: 'purple'
              },
              swagger: {
                route: '/_docs/swagger'
              }
            }
          },
    // Ensure unhead is properly bundled/traced
    externals: {
      // @vue-email/compiler dynamically loads vue-email at runtime.
      // Inline both so Nitro always ships them in production output.
      inline: ['unhead', '@vue-email/compiler', 'vue-email']
    },
    // Rate limit storage
    storage: {
      shield: {
        driver: 'memory'
      }
    },
    scheduledTasks: {
      '*/15 * * * *': ['shield:cleanBans'],
      '0 0 * * *': ['shield:cleanIpData']
    },
    imports: {
      imports: [
        {
          from: fileURLToPath(new URL('./server/utils/define-route-meta', import.meta.url)),
          name: 'defineRouteMeta',
          priority: 100
        }
      ]
    }
  },

  css: ['~/assets/css/main.css'],

  auth: {
    originEnvKey: 'AUTH_ORIGIN',
    origin: process.env.AUTH_ORIGIN || process.env.NUXT_AUTH_ORIGIN || 'http://localhost:3199',
    computedPath: '/api/auth',
    baseURL: '/api/auth',
    provider: {
      type: 'authjs'
    },
    session: {
      enableRefreshPeriodically: true,
      enableRefreshOnWindowFocus: true
    }
  },

  runtimeConfig: {
    authOrigin: process.env.NUXT_AUTH_ORIGIN || 'http://localhost:3099',
    // E2E stack must exercise real auth redirects; ignore local AUTH_BYPASS_USER.
    authBypassEnabled: process.env.E2E_MODE === 'true' ? false : !!process.env.AUTH_BYPASS_USER,
    authBypassUser: process.env.E2E_MODE === 'true' ? '' : process.env.AUTH_BYPASS_USER || '',
    authBypassName: process.env.E2E_MODE === 'true' ? '' : process.env.AUTH_BYPASS_NAME || '',

    // MCP server
    mcpEnabled: process.env.NUXT_MCP_ENABLED !== 'false',
    mcpExecutionEnabled: process.env.NUXT_MCP_EXECUTION_ENABLED !== 'false',
    mcpReadEnabled: process.env.NUXT_MCP_READ_ENABLED !== 'false',
    mcpWriteEnabled: process.env.NUXT_MCP_WRITE_ENABLED !== 'false',
    mcpAsyncEnabled: process.env.NUXT_MCP_ASYNC_ENABLED !== 'false',
    mcpDcrEnabled: process.env.NUXT_MCP_DCR_ENABLED !== 'false',
    mcpDcrOwnerUserId: process.env.NUXT_MCP_DCR_OWNER_USER_ID || '',
    mcpDcrOwnerEmail: process.env.NUXT_MCP_DCR_OWNER_EMAIL || '',
    mcpClientAllowlist: process.env.NUXT_MCP_CLIENT_ALLOWLIST || '',
    mcpDcrRateLimitPerHour: process.env.NUXT_MCP_DCR_RATE_LIMIT_PER_HOUR || '10',

    // Redis / DragonflyDB
    redisUrl: process.env.REDIS_URL || '',

    // Nutrition Feeder Service
    nutritionFeederUrl: process.env.NUTRITION_FEEDER_URL || 'https://feeds.coachwatts.com',
    nutritionFeederApiKey: process.env.NUTRITION_FEEDER_API_KEY || '',

    // Resend
    resendApiKey: process.env.RESEND_API_KEY || '',
    resendWebhookSecret: process.env.RESEND_WEBHOOK_SECRET || '',

    // Stripe Configuration
    stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    stripeSupporterProductId: process.env.STRIPE_SUPPORTER_PRODUCT_ID || '',
    stripeSupporterMonthlyPriceId: process.env.STRIPE_SUPPORTER_MONTHLY_PRICE_ID || '',
    stripeSupporterAnnualPriceId: process.env.STRIPE_SUPPORTER_ANNUAL_PRICE_ID || '',
    stripeSupporterMonthlyEurPriceId: process.env.STRIPE_SUPPORTER_MONTHLY_EUR_PRICE_ID || '',
    stripeSupporterAnnualEurPriceId: process.env.STRIPE_SUPPORTER_ANNUAL_EUR_PRICE_ID || '',
    stripeProProductId: process.env.STRIPE_PRO_PRODUCT_ID || '',
    stripeProMonthlyPriceId: process.env.STRIPE_PRO_MONTHLY_PRICE_ID || '',
    stripeProAnnualPriceId: process.env.STRIPE_PRO_ANNUAL_PRICE_ID || '',
    stripeProMonthlyEurPriceId: process.env.STRIPE_PRO_MONTHLY_EUR_PRICE_ID || '',
    stripeProAnnualEurPriceId: process.env.STRIPE_PRO_ANNUAL_EUR_PRICE_ID || '',

    // RevenueCat and provider-neutral subscription reconciliation (server-only keys)
    revenueCatApiBaseUrl: process.env.REVENUECAT_API_BASE_URL || 'https://api.revenuecat.com/v1',
    revenueCatSecretApiKey: process.env.REVENUECAT_SECRET_API_KEY || '',
    revenueCatStripePublicApiKey: process.env.REVENUECAT_STRIPE_APP_PUBLIC_API_KEY || '',
    revenueCatWebhookAuthorization: process.env.REVENUECAT_WEBHOOK_AUTHORIZATION || '',
    revenueCatAcceptSandbox: process.env.REVENUECAT_ACCEPT_SANDBOX || 'false',
    subscriptionSupporterProductIds: process.env.SUBSCRIPTION_SUPPORTER_PRODUCT_IDS || '',
    subscriptionProProductIds: process.env.SUBSCRIPTION_PRO_PRODUCT_IDS || '',

    public: {
      siteUrl: process.env.NUXT_PUBLIC_SITE_URL || 'http://localhost:3099',
      version: pkg.version,
      commitHash,
      buildDate,
      buildCodename,
      buildVersion,
      sentryRelease,
      sentryEnabled,
      sentryDsn: process.env.SENTRY_DSN || '',
      authBypassEnabled: process.env.E2E_MODE === 'true' ? false : !!process.env.AUTH_BYPASS_USER,
      authBypassUser: process.env.E2E_MODE === 'true' ? '' : process.env.AUTH_BYPASS_USER || '',
      authBypassName: process.env.E2E_MODE === 'true' ? '' : process.env.AUTH_BYPASS_NAME || '',
      stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
      stripeSupporterMonthlyPriceId: process.env.STRIPE_SUPPORTER_MONTHLY_PRICE_ID || '',
      stripeSupporterAnnualPriceId: process.env.STRIPE_SUPPORTER_ANNUAL_PRICE_ID || '',
      stripeSupporterMonthlyEurPriceId: process.env.STRIPE_SUPPORTER_MONTHLY_EUR_PRICE_ID || '',
      stripeSupporterAnnualEurPriceId: process.env.STRIPE_SUPPORTER_ANNUAL_EUR_PRICE_ID || '',
      stripeProMonthlyPriceId: process.env.STRIPE_PRO_MONTHLY_PRICE_ID || '',
      stripeProAnnualPriceId: process.env.STRIPE_PRO_ANNUAL_PRICE_ID || '',
      stripeProMonthlyEurPriceId: process.env.STRIPE_PRO_MONTHLY_EUR_PRICE_ID || '',
      stripeProAnnualEurPriceId: process.env.STRIPE_PRO_ANNUAL_EUR_PRICE_ID || '',
      subscriptionsEnabled: process.env.NUXT_PUBLIC_SUBSCRIPTIONS_ENABLED !== 'false',
      nativeSubscriptionsEnabled: process.env.NUXT_PUBLIC_NATIVE_SUBSCRIPTIONS_ENABLED === 'true',
      stravaEnabled: process.env.NUXT_PUBLIC_STRAVA_ENABLED !== 'false',
      // Sign in with Apple (Guideline 4.8) — true when Services ID + key env are present
      appleSignInEnabled: Boolean(
        process.env.NUXT_PUBLIC_APPLE_SIGN_IN_ENABLED === 'true' ||
        ((process.env.APPLE_ID || process.env.APPLE_CLIENT_ID) &&
          (process.env.APPLE_CLIENT_SECRET ||
            (process.env.APPLE_TEAM_ID &&
              process.env.APPLE_KEY_ID &&
              process.env.APPLE_PRIVATE_KEY)))
      ),
      // NOTE: `tolgee` is deliberately absent here. The Tolgee API key is a
      // secret and `runtimeConfig.public` is serialised into the client payload
      // for every visitor. It is declared only under `$development` below, so a
      // production build never carries the key. See CW-610.
      gtag: {
        // Overridden at runtime by NUXT_PUBLIC_GTAG_ID (Dokploy). Empty at build
        // is fine — the client plugin no-ops until an id is present.
        id: process.env.NUXT_PUBLIC_GTAG_ID || '',
        enabled: true
      },
      realtimeBusEnabled: !!process.env.REDIS_URL
    }
  },

  // Dev-server-only public runtime config (CW-610).
  //
  // Tolgee's in-context translation DevTools need `apiUrl` + `apiKey` in the
  // browser, but `runtimeConfig.public` is serialised into the HTML payload of
  // every response — so a key placed there ships to every visitor, in every
  // environment, regardless of `import.meta.dev`.
  //
  // `$development` is applied by c12 only when `nuxt.options.dev` is true, i.e.
  // `nuxt dev`. `nuxt build` never merges this block, so `public.tolgee` is not
  // a key of the inlined runtime config at all in a production build. That also
  // closes the runtime env-override path: nitro's `applyEnv`
  // (nitropack/dist/runtime/internal/utils.env.mjs) walks `for (const key in
  // obj)`, so `NUXT_PUBLIC_TOLGEE_API_KEY` can only overwrite a key that is
  // already declared — it cannot create one. Setting `TOLGEE_API_ENABLED=true`
  // on a deployed stack is therefore inert instead of leaking the key.
  //
  // Do NOT move this back under `runtimeConfig.public`, and do NOT add an
  // empty-string `apiKey` default there to "keep the shape stable" — declaring
  // the key is exactly what reopens the env-override path.
  $development: {
    runtimeConfig: {
      public: {
        tolgee: {
          apiUrl:
            process.env.TOLGEE_API_ENABLED === 'true'
              ? process.env.NUXT_PUBLIC_TOLGEE_API_URL || process.env.TOLGEE_API_URL
              : undefined,
          apiKey:
            process.env.TOLGEE_API_ENABLED === 'true'
              ? process.env.NUXT_PUBLIC_TOLGEE_API_KEY || process.env.TOLGEE_API_KEY
              : undefined
        }
      }
    }
  },

  devServer: {
    port: 3099
  },

  build: {
    transpile: [
      '@vue-leaflet/vue-leaflet',
      '@tolgee/vue',
      '@tolgee/web',
      '@tolgee/format-icu',
      '@modelcontextprotocol/server',
      '@modelcontextprotocol/node'
    ]
  },

  vite: {
    server: {
      watch: {
        ignored: [
          '**/examples/**',
          '**/coverage/**',
          '**/backups/**',
          '**/.output/**',
          '**/.trigger/**',
          '**/.nuxt/**',
          '**/node_modules/**'
        ]
      }
    },
    optimizeDeps: {
      include: [
        '@internationalized/date',
        '@sentry/nuxt',
        '@vueuse/core',
        'chart.js',
        'chartjs-adapter-date-fns',
        'chartjs-plugin-annotation',
        'chartjs-plugin-datalabels',
        'date-fns',
        'date-fns-tz',
        'leaflet',
        'marked',
        'qrcode',
        'vue-chartjs',
        'vuedraggable',
        'zod'
      ]
    },
    vue: {
      template: {
        compilerOptions: {
          isCustomElement: (tag) => ['rapi-doc'].includes(tag)
        }
      }
    }
  },

  sentry: {
    enabled: sentryEnabled,
    org: process.env.SENTRY_ORG || 'watt-mind',
    project: process.env.SENTRY_PROJECT || 'coach-watts-web',
    sourceMapsUploadOptions: {
      enabled: !!process.env.SENTRY_AUTH_TOKEN,
      telemetry: false
    }
  },

  sourcemap: {
    client: process.env.SOURCEMAP === 'false' ? false : 'hidden'
  },

  nuxtApiShield: {
    limit: {
      max: parseInt(process.env.WEBHOOK_RATE_LIMIT_MAX || '1000', 10),
      duration: parseInt(process.env.WEBHOOK_RATE_LIMIT_TTL || '60', 10),
      ban: 300
    },
    security: {
      trustXForwardedFor: true
    },
    routes: [
      '/api/integrations/withings/webhook',
      '/api/integrations/whoop/webhook',
      '/api/integrations/intervals/webhook',
      '/api/integrations/fitbit/webhook'
    ],
    retryAfterHeader: true
  }
})
