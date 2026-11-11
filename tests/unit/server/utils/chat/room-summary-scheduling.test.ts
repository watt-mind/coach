import { beforeEach, describe, expect, it, vi } from 'vitest'
import { scheduleChatRoomSummaryIfNeeded } from '../../../../../server/utils/chat/turn-executor'
const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  dispatch: vi.fn()
}))
vi.mock('../../../../../server/utils/db', () => ({
  prisma: { chatMessage: { findUnique: mocks.findUnique, findMany: mocks.findMany } }
}))
vi.mock('../../../../../server/utils/task-dispatcher', () => ({ dispatchTask: mocks.dispatch }))
vi.mock('../../../../../server/utils/ai-tools', () => ({ getToolsWithContext: vi.fn() }))
vi.mock('../../../../../server/utils/ws-state', () => ({ sendToUser: vi.fn() }))
vi.mock('../../../../../server/utils/services/chatContextService', () => ({
  buildAthleteContext: vi.fn()
}))
const input = {
  roomId: 'room',
  userId: 'user',
  roomName: 'Training',
  roomMetadata: {
    titleGeneratedAt: 'date',
    historySummary: 'Previous',
    lastSummarizedMessageId: 'cursor',
    summarizedCount: 900
  }
}
describe('incremental summary scheduling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findUnique.mockResolvedValue({ createdAt: new Date('2026-01-01') })
    mocks.dispatch.mockResolvedValue({})
  })
  it.each([
    [11, false],
    [12, true]
  ])('schedules at %i new messages: %s', async (count, expected) => {
    mocks.findMany.mockResolvedValue(Array.from({ length: count }, () => ({ content: 'short' })))
    expect(await scheduleChatRoomSummaryIfNeeded(input)).toBe(expected)
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: 'cursor' },
      select: { createdAt: true }
    })
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { roomId: 'room', createdAt: { gt: new Date('2026-01-01') } },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: { content: true }
    })
    expect(mocks.dispatch).toHaveBeenCalledTimes(expected ? 1 : 0)
  })
  it.each([
    [3996, false],
    [3997, true]
  ])('uses ceil(content.length / 4) at %i characters', async (length, expected) => {
    mocks.findMany.mockResolvedValue([{ content: 'x'.repeat(length) }])
    expect(await scheduleChatRoomSummaryIfNeeded(input)).toBe(expected)
  })
  it.each([
    { historySummary: null },
    { titleGeneratedAt: null },
    { lastSummarizedMessageId: null }
  ])('retains initial metadata scheduling %o', async (metadata) => {
    expect(
      await scheduleChatRoomSummaryIfNeeded({
        ...input,
        roomMetadata: { ...input.roomMetadata, ...metadata }
      })
    ).toBe(true)
    expect(mocks.findMany).not.toHaveBeenCalled()
    expect(mocks.dispatch).toHaveBeenCalledWith('summarize-chat', {
      roomId: 'room',
      userId: 'user'
    })
  })
  it('sums rounded token estimates across messages', async () => {
    mocks.findMany.mockResolvedValue([{ content: 'x'.repeat(1997) }, { content: 'x'.repeat(1997) }])
    expect(await scheduleChatRoomSummaryIfNeeded(input)).toBe(true)
  })
  it('does not dispatch when the saved cursor is already up to date', async () => {
    mocks.findMany.mockResolvedValue([])
    expect(await scheduleChatRoomSummaryIfNeeded(input)).toBe(false)
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })
  it('propagates dispatch failure to the completion callers nonfatal catch', async () => {
    mocks.findMany.mockResolvedValue(Array.from({ length: 12 }, () => ({ content: 'short' })))
    mocks.dispatch.mockRejectedValueOnce(new Error('queue unavailable'))
    await expect(scheduleChatRoomSummaryIfNeeded(input)).rejects.toThrow('queue unavailable')
  })
})
