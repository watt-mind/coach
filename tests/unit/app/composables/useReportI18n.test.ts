// @vitest-environment nuxt

import { computed } from 'vue'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useReportI18n } from '../../../../app/composables/useReportI18n'

// Static-data stand-in for the `report` namespace: one key whose value
// legitimately equals its key, one normal key, and anything else absent.
// The probe call shape `t(key, { orEmpty: true })` resolves '' for absent
// keys — mirroring Tolgee's real `orEmpty` semantics — while the plain
// `t(key)` shape echoes the raw key, as Tolgee does for missing keys.
vi.mock('@tolgee/vue', () => ({
  useTranslate: () => ({
    t: computed(() => (key: string, optionsOrDefault?: unknown) => {
      const store: Record<string, string> = { status: 'status', greeting: 'Hello' }
      const opts =
        typeof optionsOrDefault === 'object' && optionsOrDefault !== null
          ? (optionsOrDefault as Record<string, unknown>)
          : {}
      if (opts.orEmpty) return key in store ? store[key] : ''
      return key in store ? store[key] : key
    })
  })
}))

describe('useReportI18n tr() (CW-450)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the translation when its value equals its key, not the fallback', () => {
    const { tr } = useReportI18n()
    expect(tr('status', 'Status fallback')).toBe('status')
  })

  it('renders the translation when its value differs from its key', () => {
    const { tr } = useReportI18n()
    expect(tr('greeting', 'Hi fallback')).toBe('Hello')
  })

  it('uses the fallback for a genuinely missing key and warns in development', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { tr } = useReportI18n()
    expect(tr('does_not_exist', 'Missing fallback')).toBe('Missing fallback')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does_not_exist'))
    warn.mockRestore()
  })

  it('interpolates params into both translations and fallbacks', () => {
    const { tr } = useReportI18n()
    expect(tr('greeting', 'Hi {name}', { name: 'Ada' })).toBe('Hello')
    expect(tr('does_not_exist', 'Hi {name}', { name: 'Ada' })).toBe('Hi Ada')
  })
})
