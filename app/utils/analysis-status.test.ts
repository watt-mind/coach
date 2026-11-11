import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { ANALYSIS_SECTION_STATUSES } from '../../server/utils/services/workout-analysis-prompt'
import {
  ANALYSIS_STATUS_CLASSES,
  getAnalysisStatusClass,
  ANALYSIS_STATUS_COLORS,
  ANALYSIS_STATUS_FALLBACK_COLOR,
  getAnalysisStatusColor
} from './analysis-status'

/**
 * CW-424 regression coverage.
 *
 * Four surfaces used to carry their own status->colour table, so the same analysis
 * rendered amber on the report page and red on the workout page. These tests pin the
 * one shared table, and -- crucially -- pin the *legacy* vocabulary too: analyses
 * written before CW-403 still sit in `aiAnalysisJson` and are never rewritten, so
 * dropping legacy handling would quietly turn correctly-stored old analyses grey.
 */
describe('getAnalysisStatusColor', () => {
  it('colours the current vocabulary along one warm severity ramp', () => {
    expect(getAnalysisStatusColor('excellent')).toBe('success')
    expect(getAnalysisStatusColor('good')).toBe('success')
    expect(getAnalysisStatusColor('moderate')).toBe('warning')
    expect(getAnalysisStatusColor('needs_improvement')).toBe('warning')
    expect(getAnalysisStatusColor('poor')).toBe('error')
  })

  it('keeps red for the worst tier only, so it stays meaningful', () => {
    const red = Object.entries(ANALYSIS_STATUS_COLORS)
      .filter(([, color]) => color === 'error')
      .map(([status]) => status)

    expect(red).toContain('poor')
    expect(red).not.toContain('needs_improvement')
    expect(red).not.toContain('needs_attention')
  })

  it('still colours the retired pre-CW-403 vocabulary', () => {
    // `fair` and `needs_attention` are the legacy equivalents of `moderate` and
    // `needs_improvement`; `info` marked a non-severity, informational section.
    expect(getAnalysisStatusColor('fair')).toBe('warning')
    expect(getAnalysisStatusColor('needs_attention')).toBe('warning')
    expect(getAnalysisStatusColor('info')).toBe('info')
  })

  it('preserves the defensive aliases the per-page mappers carried', () => {
    expect(getAnalysisStatusColor('failing')).toBe('error')
    expect(getAnalysisStatusColor('bad')).toBe('error')
  })

  it('is case- and whitespace-insensitive', () => {
    expect(getAnalysisStatusColor('NEEDS_IMPROVEMENT')).toBe('warning')
    expect(getAnalysisStatusColor('  Excellent  ')).toBe('success')
    expect(getAnalysisStatusColor('Poor')).toBe('error')
  })

  it('falls back to neutral for missing or unrecognised statuses', () => {
    expect(getAnalysisStatusColor(undefined)).toBe(ANALYSIS_STATUS_FALLBACK_COLOR)
    expect(getAnalysisStatusColor(null)).toBe(ANALYSIS_STATUS_FALLBACK_COLOR)
    expect(getAnalysisStatusColor('')).toBe(ANALYSIS_STATUS_FALLBACK_COLOR)
    expect(getAnalysisStatusColor('   ')).toBe(ANALYSIS_STATUS_FALLBACK_COLOR)
    expect(getAnalysisStatusColor('sideways')).toBe(ANALYSIS_STATUS_FALLBACK_COLOR)
  })
})

/**
 * The mapping must not silently fall behind the schema: if someone adds a status to
 * `ANALYSIS_SECTION_STATUSES` without colouring it, it would render grey on every
 * surface and this test fails instead.
 */
describe('coverage of the schema vocabulary', () => {
  it('colours every status the analysis schema can emit', () => {
    for (const status of ANALYSIS_SECTION_STATUSES) {
      expect(
        getAnalysisStatusColor(status),
        `${status} is in ANALYSIS_SECTION_STATUSES but has no colour`
      ).not.toBe(ANALYSIS_STATUS_FALLBACK_COLOR)
    }
  })

  it('never maps a schema status to the informational blue token', () => {
    // Blue is reserved for the legacy, non-severity `info` status.
    for (const status of ANALYSIS_SECTION_STATUSES) {
      expect(getAnalysisStatusColor(status)).not.toBe('info')
    }
  })
})

/** CW-443: pin complete pairs and measure the installed Tailwind palette. */
describe('analysis status theme pairs', () => {
  const families = {
    success: 'emerald',
    warning: 'amber',
    error: 'red',
    info: 'blue',
    neutral: 'zinc'
  } as const

  it('pins one concrete palette per token', () => {
    for (const [token, family] of Object.entries(families)) {
      expect(ANALYSIS_STATUS_CLASSES[token as keyof typeof families]).toBe(
        `text-${family}-800 bg-${family}-100 border-${family}-300 dark:text-${family}-200 dark:bg-${family}-950 dark:border-${family}-700 ring-0`
      )
    }
  })

  it('uses the shared pairs for every alias and the fallback', () => {
    for (const [status, token] of Object.entries(ANALYSIS_STATUS_COLORS)) {
      expect(getAnalysisStatusClass(`  ${status.toUpperCase()}  `)).toBe(
        ANALYSIS_STATUS_CLASSES[token]
      )
    }
    for (const status of [undefined, null, '', 'unknown']) {
      expect(getAnalysisStatusClass(status)).toBe(ANALYSIS_STATUS_CLASSES.neutral)
    }
  })

  // Read the real CSS rather than a duplicated hex palette that could drift.
  const require = createRequire(import.meta.url)
  const theme = readFileSync(require.resolve('tailwindcss/theme.css'), 'utf8')
  function luminance(color: string) {
    const match = theme.match(
      new RegExp(`--color-${color}: oklch\\(([\\d.]+)% ([\\d.]+) ([\\d.]+)\\)`)
    )
    if (!match) throw new Error(`Missing Tailwind color: ${color}`)
    const lightness = Number(match[1]) / 100
    const chroma = Number(match[2])
    const hue = (Number(match[3]) * Math.PI) / 180
    const a = chroma * Math.cos(hue)
    const b = chroma * Math.sin(hue)
    // OKLab -> linear sRGB. WCAG luminance uses linear channels directly.
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
    const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
    const clamp = (value: number) => Math.max(0, Math.min(1, value))
    const r = clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)
    const g = clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)
    const blue = clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
    return 0.2126 * r + 0.7152 * g + 0.0722 * blue
  }

  for (const token of Object.keys(families) as Array<keyof typeof families>) {
    for (const dark of [false, true]) {
      it(`${token} clears AA for small text in ${dark ? 'dark' : 'light'} mode`, () => {
        const classes = ANALYSIS_STATUS_CLASSES[token].split(' ')
        const prefix = dark ? 'dark:' : ''
        const foreground = classes.find((value) => value.startsWith(`${prefix}text-`))!
        const background = classes.find((value) => value.startsWith(`${prefix}bg-`))!
        const values = [
          luminance(foreground.slice(`${prefix}text-`.length)),
          luminance(background.slice(`${prefix}bg-`.length))
        ].sort((a, b) => a - b)
        expect((values[1]! + 0.05) / (values[0]! + 0.05)).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})
