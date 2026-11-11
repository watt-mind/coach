// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { ref, computed, watch, nextTick } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Modal from '../../../../../app/components/activities/DeduplicateModal.vue'
const mocks = vi.hoisted(() => ({ runs: null as any }))
vi.mock('../../../../../app/composables/useFormat', () => ({
  useFormat: () => ({ formatDateUTC: () => 'Jan 1' })
}))
vi.mock('../../../../../app/composables/useUserRuns', () => ({
  useUserRuns: () => ({ runs: mocks.runs })
}))
let wrapper: ReturnType<typeof mount>
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  mocks.runs = ref([])
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('useFormat', () => ({ formatDateUTC: () => 'Jan 1' }))
  fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ success: true, taskId: 'scan' })
    .mockResolvedValueOnce({ success: true, taskId: 'merge' })
    .mockResolvedValueOnce({ success: true, taskId: 'fresh' })
  vi.stubGlobal('$fetch', fetchMock)
  wrapper = mount(Modal, {
    props: { open: true },
    global: {
      stubs: {
        UModal: { template: '<div><slot name="body"/><slot name="footer"/></div>' },
        UButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot/></button>' },
        UIcon: true,
        UCheckbox: true,
        UBadge: true,
        UTooltip: { template: '<span><slot/></span>' }
      }
    }
  })
})
afterEach(() => {
  wrapper?.unmount()
  vi.unstubAllGlobals()
})
async function click(label: string) {
  const button = wrapper.findAll('button').find((b) => b.text().includes(label))
  expect(button, label).toBeDefined()
  await button!.trigger('click')
  await flushPromises()
}
async function complete(id: string, output: any) {
  mocks.runs.value = [{ id, status: 'COMPLETED', output }]
  await nextTick()
}
const group = (id: string) => ({
  bestWorkoutId: id,
  workouts: [{ id, title: id, date: '2026-01-01', durationSec: 60 }],
  toDelete: []
})
async function merge() {
  await click('Scan for Duplicates')
  expect(wrapper.text()).toContain('Scanning for Duplicates...')
  await complete('scan', { duplicateGroups: [group('old')] })
  await click('Merge 1 Groups')
  expect(wrapper.text()).toContain('Merging Activities...')
}
it.each([undefined, 0])('preserves success for legacy/zero skips (%s)', async (groupsSkipped) => {
  await merge()
  await complete('merge', { workoutsKept: 2, workoutsDeleted: 3, groupsSkipped })
  expect(wrapper.text()).toContain('Deduplication Complete')
  expect(wrapper.text()).toContain('Successfully merged 2 activities and marked 3 as duplicates.')
  expect(wrapper.text()).not.toContain('Scan Again')
  expect(wrapper.emitted('updated')).toHaveLength(1)
})
it.each([
  [1, 2, 3],
  [2, 0, 0]
])('qualifies %s skips and scans fresh', async (groupsSkipped, workoutsKept, workoutsDeleted) => {
  await merge()
  await complete('merge', { groupsSkipped, workoutsKept, workoutsDeleted })
  expect(wrapper.text()).toContain('Completed with Skipped Groups')
  expect(wrapper.text()).toContain(
    `${groupsSkipped} duplicate groups were skipped because records changed`
  )
  expect(wrapper.text()).toContain(
    `merged ${workoutsKept} activities and marked ${workoutsDeleted}`
  )
  expect(wrapper.emitted('updated')).toHaveLength(1)
  await click('Scan Again')
  expect(fetchMock).toHaveBeenLastCalledWith('/api/workouts/deduplicate', {
    method: 'POST',
    body: { dryRun: true }
  })
  expect(wrapper.text()).not.toContain('old')
  await complete('merge', { workoutsKept: 99 })
  expect(wrapper.text()).toContain('Scanning for Duplicates...')
  await complete('fresh', { duplicateGroups: [group('new'), group('new2')] })
  expect(wrapper.text()).toContain('Merge 2 Groups')
})
