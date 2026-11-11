// @vitest-environment nuxt

import { computed } from 'vue'
import { Tolgee } from '@tolgee/web'
import { FormatIcu } from '@tolgee/format-icu'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useReportI18n } from '../../../../app/composables/useReportI18n'

// Mock only Vue injection; every lookup uses the installed Tolgee implementation.
const bridge = vi.hoisted(() => ({ t: undefined as unknown }))
vi.mock('@tolgee/vue', () => ({
  useTranslate: () => ({ t: computed(() => bridge.t) })
}))

describe('useReportI18n tr() (CW-450)', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    const tolgee = Tolgee()
      .use(FormatIcu())
      .init({
        language: 'es',
        fallbackLanguage: 'en',
        defaultNs: 'report',
        ns: ['report'],
        staticData: {
          'es:report': { status: 'status', greeting: 'Hola', empty: '', marker: 'missing' },
          'en:report': { empty: 'English empty fallback', english: 'English', englishEmpty: '' }
        }
      })
    await tolgee.run()
    bridge.t = (key: string, ...args: unknown[]) =>
      (tolgee.t as (...args: unknown[]) => string)(key, ...args)
  })

  it.each([
    ['status', 'status'],
    ['greeting', 'Hola'],
    ['empty', ''],
    ['english', 'English'],
    ['englishEmpty', ''],
    ['marker', 'missing']
  ])('preserves resolved %s without a missing-key warning', (key, expected) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(useReportI18n().tr(key, 'Caller fallback')).toBe(expected)
    expect(warn).not.toHaveBeenCalled()
  })

  it('uses and interpolates the fallback for an absent key and warns in development', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(useReportI18n().tr('absent', 'Hi {name}', { name: 'Ada' })).toBe('Hi Ada')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('absent'))
  })

  it('retains the ordinary wrapped lookup for rendering', () => {
    const realT = bridge.t as (...args: unknown[]) => string
    const t = vi.fn((...args: unknown[]) => realT(...args))
    bridge.t = t
    expect(useReportI18n().tr('greeting', 'Fallback')).toBe('Hola')
    expect(t).toHaveBeenLastCalledWith('greeting')
  })

  it('retains parameter interpolation for translations without ICU formatting', async () => {
    const tolgee = Tolgee().init({ language: 'en', staticData: { en: { hello: 'Hi {name}' } } })
    await tolgee.run()
    bridge.t = tolgee.t
    expect(useReportI18n().tr('hello', 'Fallback', { name: 'Ada' })).toBe('Hi Ada')
  })
})
