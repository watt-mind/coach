import { beforeEach, describe, expect, it, vi } from 'vitest'
import { summarizeChatTask } from '../../../trigger/summarize-chat'
const m = vi.hoisted(() => ({
  room: vi.fn(),
  cursor: vi.fn(),
  messages: vi.fn(),
  update: vi.fn(),
  usage: vi.fn(),
  generate: vi.fn(),
  extract: vi.fn(),
  memories: vi.fn(),
  save: vi.fn()
}))
vi.mock('@trigger.dev/sdk/v3', () => ({
  task: (definition: any) => definition,
  logger: { info: vi.fn(), error: vi.fn() }
}))
vi.mock('../../../server/utils/db', () => ({
  prisma: {
    chatRoom: { findUnique: m.room, update: m.update },
    chatMessage: { findUnique: m.cursor, findMany: m.messages },
    llmUsage: { create: m.usage }
  }
}))
vi.mock('@ai-sdk/google', () => ({ createGoogle: () => vi.fn() }))
vi.mock('ai', () => ({ generateText: m.generate }))
vi.mock('../../../server/utils/ai-config', () => ({ calculateLlmCost: () => 0 }))
vi.mock('../../../server/utils/chat/memory-extraction', () => ({
  extractMemoryCandidatesFromConversation: m.extract
}))
vi.mock('../../../server/utils/services/userMemoryService', () => ({
  userMemoryService: { listMemories: m.memories, saveMemoryCandidates: m.save }
}))
const run = (summarizeChatTask as any).run
const date = new Date('2026-01-01')
const messages = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `new-${i}`,
    content: `New context ${i}`,
    senderId: i % 2 ? 'ai_agent' : 'user'
  }))
describe('summarize-chat incremental task', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.room.mockResolvedValue({
      name: 'Training',
      metadata: {
        historySummary: 'Previous goals',
        lastSummarizedMessageId: 'old',
        summarizedCount: 80,
        titleGeneratedAt: 'date',
        custom: 'preserved'
      }
    })
    m.cursor.mockResolvedValue({ createdAt: date })
    m.generate.mockResolvedValue({
      text: 'Updated goals',
      usage: { inputTokens: 10, outputTokens: 5 }
    })
    m.memories.mockResolvedValue([])
    m.extract.mockResolvedValue({ candidates: [{ content: 'goal' }] })
  })
  it('includes prior summary, queries only the next capped batch and advances cursor/count', async () => {
    m.messages.mockResolvedValue(messages(12))
    await run({ roomId: 'room', userId: 'user' })
    expect(m.messages).toHaveBeenCalledWith({
      where: { roomId: 'room', createdAt: { gt: date } },
      orderBy: { createdAt: 'asc' },
      take: 50
    })
    expect(m.generate).toHaveBeenCalledTimes(1)
    expect(m.generate.mock.calls[0][0].instructions).toContain('Previous goals')
    expect(m.generate.mock.calls[0][0].prompt).toContain('New context 0')
    expect(m.generate.mock.calls[0][0].prompt).not.toContain('Previous goals')
    expect(m.update).toHaveBeenCalledWith({
      where: { id: 'room' },
      data: {
        name: undefined,
        metadata: expect.objectContaining({
          historySummary: 'Updated goals',
          lastSummarizedMessageId: 'new-11',
          summarizedCount: 92,
          custom: 'preserved',
          titleGeneratedAt: 'date'
        })
      }
    })
    expect(m.extract.mock.calls[0][0].messages).toHaveLength(12)
    expect(m.save).toHaveBeenCalled()
  })
  it('does not advance below both thresholds', async () => {
    m.messages.mockResolvedValue(messages(11))
    await run({ roomId: 'room', userId: 'user' })
    expect(m.generate).not.toHaveBeenCalled()
    expect(m.update.mock.calls[0][0].data.metadata).toMatchObject({
      historySummary: 'Previous goals',
      lastSummarizedMessageId: 'old',
      summarizedCount: 80
    })
  })
  it.each([
    [3996, false],
    [3997, true]
  ])('handles incremental token boundary %i', async (length, expected) => {
    m.messages.mockResolvedValue([{ id: 'large', content: 'x'.repeat(length), senderId: 'user' }])
    await run({ roomId: 'room', userId: 'user' })
    expect(m.generate).toHaveBeenCalledTimes(expected ? 1 : 0)
  })
  it('retains first summary and title generation', async () => {
    m.room.mockResolvedValue({ name: 'New Chat', metadata: { custom: 'preserved' } })
    m.messages.mockResolvedValue(messages(4))
    await run({ roomId: 'room', userId: 'user' })
    expect(m.generate).toHaveBeenCalledTimes(2)
    expect(m.update.mock.calls[0][0].data).toMatchObject({
      name: 'Updated goals',
      metadata: { lastSummarizedMessageId: 'new-3', summarizedCount: 4, custom: 'preserved' }
    })
  })
  it('advances through a full 50-message batch', async () => {
    m.messages.mockResolvedValue(messages(50))
    await run({ roomId: 'room', userId: 'user' })
    expect(m.update.mock.calls[0][0].data.metadata).toMatchObject({
      lastSummarizedMessageId: 'new-49',
      summarizedCount: 130
    })
  })
  it('generates an initial title without moving the summary cursor', async () => {
    m.room.mockResolvedValue({ name: 'New Chat', metadata: { custom: 'preserved' } })
    m.messages.mockResolvedValue(messages(2))
    await run({ roomId: 'room', userId: 'user' })
    expect(m.generate).toHaveBeenCalledTimes(1)
    expect(m.update.mock.calls[0][0].data.metadata).not.toHaveProperty('lastSummarizedMessageId')
  })
  it('does nothing when the cursor is up to date', async () => {
    m.messages.mockResolvedValue([])
    expect(await run({ roomId: 'room', userId: 'user' })).toEqual({
      success: true,
      reason: 'up_to_date'
    })
    expect(m.generate).not.toHaveBeenCalled()
    expect(m.update).not.toHaveBeenCalled()
  })
})
