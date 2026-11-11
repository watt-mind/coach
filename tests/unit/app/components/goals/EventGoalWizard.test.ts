// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EventGoalWizard from '../../../../../app/components/goals/EventGoalWizard.vue'

const fetchMock = vi.fn()

vi.mock('../../../../../app/composables/useFormat', () => ({
  useFormat: () => ({
    formatDate: (date: string) => date,
    formatDateUTC: (date: string) => date.slice(0, 10),
    getUserDateFromLocal: (date: string) => new Date(`${date}T00:00:00.000Z`),
    getUserLocalDate: () => new Date('2026-08-10T00:00:00.000Z')
  })
}))

function mountWizard(goalDistance: number) {
  return mount(EventGoalWizard, {
    props: {
      goal: {
        id: 'goal-1',
        type: 'EVENT',
        title: 'Autumn Fondo',
        distance: goalDistance,
        events: [{ id: 'event-1' }]
      }
    },
    global: {
      stubs: {
        UButton: { template: '<button><slot /></button>' },
        UIcon: { template: '<i />' },
        UFormField: { template: '<div><slot name="label" /><slot /><slot name="help" /></div>' },
        UInput: { template: '<input />' },
        UInputNumber: { template: '<input />' },
        USelect: { template: '<select />' },
        UTextarea: { template: '<textarea />' }
      }
    }
  })
}

describe('EventGoalWizard', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue([
      {
        id: 'event-1',
        title: 'Autumn Fondo',
        date: '2026-10-15T00:00:00.000Z',
        distance: null,
        elevation: null
      }
    ])
    vi.stubGlobal('$fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it('uses the saved goal distance when the linked event has no distance', async () => {
    const wrapper = mountWizard(42.2)

    await flushPromises()

    expect(wrapper.text()).toContain('42.2 km')
  })

  it('renders a zero saved distance instead of N/A', async () => {
    const wrapper = mountWizard(0)

    await flushPromises()

    expect(wrapper.text()).toContain('0 km')
  })
  it.each([
    {
      name: 'omitted',
      metadata: {},
      distance: undefined,
      elevation: undefined,
      duration: undefined,
      type: 'Road Race',
      terrain: 'Rolling'
    },
    {
      name: 'zero',
      metadata: { distance: 0, elevation: 0, expectedDuration: 0 },
      distance: 0,
      elevation: 0,
      duration: 0,
      type: 'Road Race',
      terrain: 'Rolling'
    }
  ])(
    'replaces primary event metadata with $name values in the creation payload',
    async (scenario) => {
      const first = {
        id: 'first',
        title: 'First',
        date: '2026-10-15',
        distance: 100,
        elevation: 2000,
        expectedDuration: 5,
        type: 'Trail',
        terrain: 'Hilly'
      }
      const second = { id: 'second', title: 'Second', date: '2026-10-16', ...scenario.metadata }
      fetchMock.mockResolvedValue([first, second])
      const wrapper = mount(EventGoalWizard, {
        global: {
          stubs: {
            UButton: { template: '<button><slot /></button>' },
            UIcon: true,
            UFormField: { template: '<div><slot /></div>' },
            UInput: true,
            UInputNumber: true,
            USelect: true,
            UTextarea: true
          }
        }
      })
      const vm = wrapper.vm as any
      vm.selectType('EVENT')
      await flushPromises()
      vm.toggleUserEvent(first)
      vm.toggleUserEvent(second)
      await vm.saveGoal()
      const payload = fetchMock.mock.calls.find((call) => call[0] === '/api/goals')?.[1].body
      expect(payload).toMatchObject({
        distance: scenario.distance,
        elevation: scenario.elevation,
        duration: scenario.duration,
        eventType: scenario.type,
        terrain: scenario.terrain
      })
      expect(payload.aiContext).toContain(
        `Distance: ${scenario.distance}km. Elevation: ${scenario.elevation}m. Terrain: ${scenario.terrain}. Expected Duration: ${scenario.duration}h.`
      )
    }
  )
})
