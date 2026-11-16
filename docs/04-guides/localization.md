# Localization Guide

This document explains how internationalization (i18n) and localization are implemented in Coach Watts using **Tolgee** and **Nuxt UI**.

## 1. Core Technologies

- **[Tolgee](https://tolgee.io/)**: Used for managing translation strings, namespaces, and providing an in-context translation editor during development.
- **[@tolgee/vue](https://tolgee.io/docs/web/using_with_vue/installation)**: The Vue SDK for Tolgee integration.
- **[Nuxt UI Locales](https://ui.nuxt.com/getting-started/i18n)**: Used for standardizing locale names and integrating with Nuxt UI components like `ULocaleSelect`.

## 2. Project Structure

Translations are stored as JSON files in `app/i18n/`, organized by language and namespace:

```text
app/i18n/
├── en/                # English (source of truth)
│   ├── common.json    # Shared strings (nav, footer, CTA)
│   ├── hero.json      # Landing page hero section
│   └── ...
├── hu/                # Hungarian
│   ├── common.json
│   └── ...
└── de/                # German
    ├── common.json
    └── ...
```

Each filename is the **namespace**. One namespace per page or feature area.

## 3. Configuration

### Tolgee Plugin (`app/plugins/tolgee.ts`)

The Tolgee instance is initialized in a Nuxt plugin. It handles:

1. **Static Data**: Importing and registering local JSON files for SSR and initial load.
2. **Language Detection**: Using `@tolgee/web`'s `LanguageDetector` and `LanguageStorage`.
3. **Fallback Language**: `fallbackLanguage: 'en'` — see [§6](#6-missing-translations-and-the-english-fallback).
4. **DevTools**: Enabling the in-context editor in development mode when API keys are present.

> **Critical**: Every namespace JSON file must be explicitly imported and added to `staticData` in this plugin. A namespace missing for **`en`** shows raw keys in every locale — the English fallback has nothing to resolve against. A namespace missing for a translated locale falls back to English ([§6](#6-missing-translations-and-the-english-fallback)), which is degraded but not broken.

### Adding a New Language

To add a new language (e.g., French - `fr`):

1. Create `app/i18n/fr/` and add the necessary JSON files (copy from `en/` as a base).
2. In `app/plugins/tolgee.ts`: import the new files and add them to `staticData`.
3. In `app/components/LanguageSwitcher.vue`: import the locale from `@nuxt/ui/locale` and add it to the `locales` array.

## 4. Translating a Page or Component

Follow these steps every time you add i18n to a new page or component.

### Step 1 — Create the English JSON

Create `app/i18n/en/{namespace}.json` with all translatable strings as flat keys:

```json
{
  "header_title": "Athlete Stories",
  "header_description": "Real athletes achieving peak performance.",
  "cta_button": "Start Your Journey"
}
```

Key naming convention: `section_element` (flat, underscored). No nesting. Match the pattern used in `bento.json`, `community.json`, etc.

### Step 2 — Update the Vue file

```vue
<script setup lang="ts">
  import { useTranslate } from '@tolgee/vue'

  const { t } = useTranslate('namespace') // matches the JSON filename
</script>

<template>
  <h1>{{ t('header_title') }}</h1>
</template>
```

### Step 3 — Register the namespace in the plugin

In `app/plugins/tolgee.ts`, add two things:

```ts
// 1. Import
import enStories from '../i18n/en/stories.json'
import huStories from '../i18n/hu/stories.json' // only when the file exists

// 2. Register in staticData
staticData: {
  'en:stories': enStories,
  'hu:stories': huStories, // only when the file exists
}
```

Do **not** add a language entry until its translated file actually exists on disk — the import will fail at build time.

### Step 4 — Verify extraction

```bash
npx tolgee extract print --patterns "app/pages/your-page.vue"
```

Should show 0 warnings. If you see `Expected source of t function`, the extractor can't trace `t` back to `useTranslate` — usually because `t` is passed as a prop or used outside `<script setup>`.

### Step 5 — Push keys and pull translations

Run the all-in-one sync command:

```bash
cw:cli translations sync-all
```

This does everything in one shot:

1. Pushes all English values from every `app/i18n/en/*.json` to the platform (creates missing keys automatically)
2. Warns about any namespace files not registered in `tolgee.ts` staticData
3. Pulls translated files for all languages

After pulling, any new language files (e.g. `app/i18n/hu/{namespace}.json`) will be created. Register them in the plugin (Step 3).

> **Note:** `pnpm i18n:push` is not recommended for new namespaces — it does not correctly assign the namespace on the platform. Use `sync-all` or `push-values` instead.

## 5. Using `t()` in Script vs Template

`t` from `useTranslate` is a `ComputedRef<Function>`. Vue auto-unwraps it in templates but **not** in `<script setup>`.

| Context                | Syntax                                                 |
| ---------------------- | ------------------------------------------------------ |
| Template               | `{{ t('key') }}`                                       |
| `computed()` in script | `t.value('key')`                                       |
| `useHead()`            | `useHead(computed(() => ({ title: t.value('key') })))` |
| Dynamic data arrays    | `computed(() => [{ label: t.value('key') }])`          |

## 6. Missing Translations and the English Fallback

### The rule

**`app/plugins/tolgee.ts` sets `fallbackLanguage: 'en'`. Rely on it. New code writes plain `t('key')` and does not need a per-call English default.**

### Why it exists

Tolgee renders the **raw key** when a key is absent from the active locale's data — a Hungarian visitor literally sees `upload_title` instead of "Manual Ingestion". This is not an edge case: `en` is the source of truth, so **every newly-added English key is a raw-key defect in every other locale until it is translated**. Whole namespaces are affected too — a namespace registered for `en` but not yet for `hu` renders every one of its keys raw.

`fallbackLanguage: 'en'` fixes the whole app in one place: a lookup that misses in the active locale resolves against `en` instead of falling through to the identifier. A locale that _does_ have the key still wins — the fallback only fills gaps (CW-524).

### Per-call `defaultValue` — legacy, kept deliberately

Tolgee also supports a per-call English default:

```vue
{{ t('upload_title', 'Manual Ingestion') }}
```

CW-11 and CW-106 shipped roughly 240 of these across `reports.vue`, `workouts/upload.vue` and the coaching pages, as a workaround **before** the fallback existed. They are now redundant but harmless — the two mechanisms do not conflict, and the per-call default is simply never reached once the `en` record resolves.

**They were intentionally left in place.** Stripping ~240 call sites is a large, risky diff across many page files for zero user-visible gain. Do not remove them opportunistically as drive-by cleanup; if a page is being substantially rewritten anyway, dropping them there is fine.

So, when you encounter them:

| Situation                                 | What to do                                      |
| ----------------------------------------- | ----------------------------------------------- |
| Writing new code                          | `t('key')` — no default, the fallback covers it |
| Editing a line that already has a default | Leave it, or drop the default; both are correct |
| Tempted to bulk-remove the existing ~240  | Don't — separate ticket, not a drive-by         |

### Verifying

Typecheck and lint cannot catch a missing translation — the only gate is looking at a page. Load it under `?lang=hu` (or any locale whose JSON is behind `en`) and confirm English words render where the translation is missing, and that no `snake_case` identifiers appear as visible text:

```bash
bin/worktree-dev.sh   # NOT bare `pnpm dev` — that binds the main checkout's port
curl -sL "http://localhost:<port>/activities?lang=hu" | grep -o 'controls_view_calendar'
```

## 7. npm Scripts

| Command          | What it does                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm i18n:pull` | Pull all translated files from the Tolgee platform                                                  |
| `pnpm i18n:push` | Push `en/` and `hu/` files to the platform — **use only for existing namespaces with known values** |

## 8. `cw:cli translations` Commands

Prefer these over raw Tolgee CLI calls — they handle env vars, error output, and namespace parsing automatically.

| Command                                            | When to use                                                                                                 |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `cw:cli translations sync-all`                     | **Full sync** — push all English values, check registration, pull translations. Use this for routine syncs. |
| `cw:cli translations check`                        | Before pushing — verifies namespace registration in `tolgee.ts` and runs extraction warnings check          |
| `cw:cli translations status`                       | Overview of which languages have which namespace JSON files                                                 |
| `cw:cli translations list-missing`                 | Lists keys present in code but missing from the platform                                                    |
| `cw:cli translations sync`                         | Creates key stubs on the platform with the correct namespace (reads from code)                              |
| `cw:cli translations push-values --namespace <ns>` | Sets English values for a single namespace via the API. Auto-creates missing keys.                          |

### Deleting keys from the platform

After deleting keys in the Tolgee UI, always pull to keep local files in sync:

```bash
pnpm i18n:pull
```

Without pulling, the deleted keys remain in local JSON files. The next `pnpm i18n:push` or `cw:cli translations push-values` would re-create them on the platform. Commit the updated JSON files after pulling.

## 9. Development In-Context Editor

The in-context editor only works in local development (`nuxt dev`). It stays disabled unless all three settings below are present, and the credentials never ship to production:

1. Set the following in your local `.env` (see `.env.example`):
   ```bash
   TOLGEE_API_ENABLED=true
   TOLGEE_API_URL=https://app.tolgee.io
   TOLGEE_API_KEY=<your-personal-key>
   ```
   `TOLGEE_API_ENABLED=true` is the master switch — without it, `nuxt.config.ts` exposes no Tolgee credentials to the browser and `app/plugins/tolgee.ts` skips the DevTools, so `Alt + Click` does nothing. The translation sync CLI (`cw:cli translations sync-all`) likewise refuses live-API calls without it.
2. In development, `Alt + Click` (or `Option + Click`) on any translated string to open the Tolgee dialog.
3. Changes made in the Tolgee UI can be pulled back with `pnpm i18n:pull`.

> **Dev-only by design (CW-610).** `nuxt.config.ts` declares the public `tolgee` runtime config only under `$development`, and only when `TOLGEE_API_ENABLED=true`. A production build (`nuxt build`) therefore carries no Tolgee API key — setting the flag on a deployed stack is inert instead of leaking the key. Never commit a real `TOLGEE_API_KEY`; keep it in your local `.env`.

## 10. Best Practices

1. **One namespace per page/feature** — keep JSON files small and focused. Use `common.json` only for shared elements (nav, footer).
2. **Flat keys** — use `section_element` format (e.g., `header_title`, `cta_button`). Match the convention in `bento.json` and `community.json`. Dotted nesting is supported but only used in `common.json` and `support.json` for historical reasons.
3. **Always register in the plugin** — a namespace not in `staticData` for **`en`** in `tolgee.ts` renders as raw keys in every locale, because the English fallback has nothing to resolve against. Missing it for a _translated_ locale only is now survivable — that locale falls back to English ([§6](#6-missing-translations-and-the-english-fallback)) — but register it anyway.
4. **Use `cw:cli translations sync` for new namespaces** — `pnpm i18n:push` does not correctly namespace new keys on the platform. Use `sync` + `push-values` instead.
5. **Pull after deleting keys** — after deleting keys in the Tolgee UI, run `pnpm i18n:pull` to remove them from local JSON files. Otherwise the next push will re-create them.
6. **English is the source of truth** — always provide an English value for every key. Other languages fall back to English if untranslated, via `fallbackLanguage: 'en'` in the plugin ([§6](#6-missing-translations-and-the-english-fallback)). Write plain `t('key')`; a per-call English default is not needed.
7. **Proper nouns don't need translation** — names like "Sarah Jenkins" can stay as literals in computed arrays.
8. **Admin pages exclusion** — pages and components under `/admin/` (e.g., `app/pages/admin/**`) are intended for internal use only and **do not need to be translated**. They should remain in English.
