import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { TypedEventStream, type CatchUpEvent, type Message } from '@photon-ai/advanced-imessage/grpc'
import { describe, expect, it } from 'vitest'
import { advancedChats, advancedPull, advancedReply, advancedThread, clientMessageId, kindOf, type AdvancedPort } from '../src/advanced.ts'
import { BridgeError, PULL_LIMIT, formatCursor, parseCursor } from '../src/bridge.ts'
import { modeOf } from '../src/cli.ts'

const run = promisify(execFile)
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'imsg-bridge')
const DM = 'any;-;+15550102000'
const GROUP = 'any;+;8812'
const T0 = Date.parse('2026-11-01T07:00:00.000Z')

function message(guid: string, overrides: Partial<Message> = {}): Message {
  return {
    guid, chatGuids: [DM], content: { text: `message ${guid}`, attachments: [], formatting: [], mentions: [] },
    dateCreated: new Date(T0), isFromMe: false, sender: { address: '+15550102000', service: 'iMessage' }, itemType: 'normal',
    isAutoReply: false, isSystemMessage: false, isServiceMessage: false, appliedReactions: [], placedStickers: [],
    ...overrides,
  } as unknown as Message
}
const received = (sequence: number, m: Message): CatchUpEvent =>
  ({ type: 'message.received', sequence, message: m, chatGuid: m.chatGuids[0]!, isFromMe: m.isFromMe, occurredAt: m.dateCreated })

/** A server with a durable event log, message history and chats, recording sends; `catchUp` replays as the real one does. */
function fakeServer(log: CatchUpEvent[] = [], history: Message[] = []) {
  const sent: { chat: string; text: string; clientMessageId?: string }[] = []
  const seen = new Set<string>()
  const closed: number[] = []
  const port: AdvancedPort = {
    events: {
      catchUp: since => {
        const events = log.filter(event => event.type === 'catchup.complete' || event.sequence > (since ?? 0))
        const head = Math.max(0, ...log.map(event => event.type === 'catchup.complete' ? 0 : event.sequence))
        return new TypedEventStream((async function* () { yield* events; yield { type: 'catchup.complete', headSequence: head } as const })(),
          async () => { closed.push(since ?? 0) })
      },
    },
    messages: {
      listInChat: async (chat, options) => {
        const rows = history.filter(m => m.chatGuids.includes(chat) && (!options?.before || m.dateCreated < options.before))
          .sort((a, b) => b.dateCreated.getTime() - a.dateCreated.getTime())
        const size = options?.pageSize ?? 25
        return { messages: rows.slice(0, size), ...rows.length > size ? { nextPageToken: 'more' } : {} }
      },
      listRecent: async options => {
        const rows = [...history].sort((a, b) => b.dateCreated.getTime() - a.dateCreated.getTime())
        const start = options?.pageToken ? Number(options.pageToken) : 0, size = options?.pageSize ?? 25
        const end = start + size
        return { messages: rows.slice(start, end), ...end < rows.length ? { nextPageToken: String(end) } : {} }
      },
      sendText: async (chat, text, options) => {
        if (chat === 'any;-;gone') throw Object.assign(new Error('no such chat'), { code: 'chatNotFound' })
        if (chat === 'any;-;limited') throw Object.assign(new Error('slow down'), { code: 'dailyLimitExceeded' })
        const id = options?.clientMessageId
        if (id && seen.has(id)) throw Object.assign(new Error('duplicate'), { code: 'duplicateMessage' })
        if (id) seen.add(id)
        sent.push({ chat, text, ...id ? { clientMessageId: id } : {} })
        return message(`out-${sent.length}`, { chatGuids: [chat], isFromMe: true })
      },
    },
    chats: { get: async chat => ({ guid: chat, displayName: chat === GROUP ? 'Acme team' : '' }) as never },
  }
  return { port, sent, closed }
}

describe('advanced mode: pull', () => {
  it('starts at the head of the log without replaying the history', async () => {
    const { port, closed } = fakeServer([received(1, message('A')), received(2, message('B'))])
    const page = await advancedPull(port, undefined, T0)
    expect(page.items).toEqual([])
    expect(parseCursor(page.next)).toEqual({ rowId: 2, at: T0 })
    expect(closed).toEqual([0])
  })

  it('answers the messages after the cursor, oldest first, in the Source shape', async () => {
    const group = message('G', { chatGuids: [GROUP], groupTitle: 'Acme team', dateCreated: new Date(T0 + 2000), replyTargetGuid: 'A' })
    const { port } = fakeServer([received(1, message('A')), received(2, message('B', { dateCreated: new Date(T0 + 1000) })), received(3, group)])
    const page = await advancedPull(port, formatCursor({ rowId: 1, at: T0 }))
    expect(page.items).toEqual([
      { id: 'B', rowId: 2, chatId: DM, chatKind: 'dm', sender: '+15550102000', fromMe: false, bot: false, text: 'message B', at: new Date(T0 + 1000).toISOString() },
      { id: 'G', rowId: 3, chatId: GROUP, chatKind: 'group', chatName: 'Acme team', sender: '+15550102000', fromMe: false, bot: false,
        text: 'message G', at: new Date(T0 + 2000).toISOString(), replyTo: 'A' },
    ])
    expect(parseCursor(page.next)).toEqual({ rowId: 3, at: T0 + 2000 })
    expect((await advancedPull(port, page.next)).items).toEqual([])
  })

  it('moves past Tapbacks, retracted messages and other events without answering them', async () => {
    const log: CatchUpEvent[] = [
      received(2, message('tapback', { reactionTargetGuid: 'A' })),
      received(3, message('gone', { dateRetracted: new Date(T0) })),
      { type: 'message.read', sequence: 4, messageGuid: 'A', readAt: new Date(T0), chatGuid: DM, isFromMe: true, occurredAt: new Date(T0) },
      received(5, message('rename', { itemType: 'groupNameChange' })),
    ]
    const page = await advancedPull(fakeServer(log).port, formatCursor({ rowId: 1, at: T0 }))
    expect(page.items).toEqual([])
    expect(parseCursor(page.next).rowId).toBe(5)
  })

  it('marks the agent’s own messages and auto-replies so they never become work', async () => {
    const log = [received(2, message('mine', { isFromMe: true })), received(3, message('focus', { isAutoReply: true }))]
    const { items } = await advancedPull(fakeServer(log).port, formatCursor({ rowId: 1, at: T0 }))
    expect(items.map(item => [item.id, item.sender, item.fromMe, item.bot])).toEqual([['mine', '', true, false], ['focus', '+15550102000', false, true]])
  })

  it('stops a page at the limit and continues from its last message', async () => {
    const log = Array.from({ length: PULL_LIMIT + 5 }, (_, index) => received(index + 1, message(`m${index + 1}`)))
    const { port } = fakeServer(log)
    const first = await advancedPull(port, formatCursor({ rowId: 0, at: T0 }))
    expect(first.items).toHaveLength(PULL_LIMIT)
    expect(parseCursor(first.next).rowId).toBe(PULL_LIMIT)
    const second = await advancedPull(port, first.next)
    expect(second.items.map(item => item.id)).toEqual(['m201', 'm202', 'm203', 'm204', 'm205'])
  })

  it('refuses an unreadable cursor', async () => {
    await expect(advancedPull(fakeServer().port, 'nonsense')).rejects.toThrow(BridgeError)
  })
})

describe('advanced mode: reply', () => {
  it('sends once per key, with a stable id the server deduplicates', async () => {
    const { port, sent } = fakeServer()
    expect(await advancedReply(port, DM, 'outbox-1', 'On it')).toEqual({ status: 'sent' })
    expect(await advancedReply(port, DM, 'outbox-1', 'On it')).toEqual({ status: 'sent', duplicate: true })
    expect(sent).toEqual([{ chat: DM, text: 'On it', clientMessageId: clientMessageId('outbox-1') }])
    expect(clientMessageId('outbox-1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(clientMessageId('outbox-2')).not.toBe(clientMessageId('outbox-1'))
  })

  it('answers 410 for a chat the line does not have, and passes other failures through', async () => {
    const { port } = fakeServer()
    await expect(advancedReply(port, 'any;-;gone', 'k', 'hi')).rejects.toMatchObject({ code: 410 })
    await expect(advancedReply(port, 'any;-;limited', 'k', 'hi')).rejects.toMatchObject({ code: 'dailyLimitExceeded' })
    await expect(advancedReply(port, DM, 'k', '  ')).rejects.toMatchObject({ code: 400 })
  })
})

describe('advanced mode: thread and chats', () => {
  const history = [
    message('A', { dateCreated: new Date(T0) }),
    message('B', { dateCreated: new Date(T0 + 1000) }),
    message('tapback', { dateCreated: new Date(T0 + 1500), reactionTargetGuid: 'B' }),
    message('C', { dateCreated: new Date(T0 + 2000) }),
    message('G', { chatGuids: [GROUP], dateCreated: new Date(T0 + 3000) }),
  ]

  it('reads a chat oldest first and names the older page', async () => {
    const { port } = fakeServer([], history)
    const newest = await advancedThread(port, DM, 2)
    expect(newest.items.map(item => item.id)).toEqual(['C'])
    expect(newest.next).toBe(new Date(T0 + 1500).toISOString())
    const older = await advancedThread(port, DM, 2, newest.next)
    expect(older.items.map(item => item.id)).toEqual(['A', 'B'])
    expect(older.next).toBeUndefined()
    await expect(advancedThread(port, DM, 2, 'yesterday')).rejects.toThrow(BridgeError)
  })

  it('lists the chats of the newest messages, most recent first, naming groups from the server', async () => {
    expect(await advancedChats(fakeServer([], history).port)).toEqual([
      { chatId: GROUP, name: 'Acme team', kind: 'group' },
      { chatId: DM, name: null, kind: 'dm' },
    ])
  })

  it('reads a chat guid’s kind', () => {
    expect([kindOf(DM), kindOf(GROUP), kindOf('chat123')]).toEqual(['dm', 'group', 'unknown'])
  })
})

describe('advanced mode: the CLI', () => {
  it('is a mode of its own', () => {
    expect(modeOf({ IMSG_BRIDGE_MODE: 'advanced' })).toBe('advanced')
  })

  it('needs the server address and token, and has no serve command', async () => {
    const env = { ...process.env, IMSG_BRIDGE_MODE: 'advanced', PHOTON_IMESSAGE_ADDRESS: '', PHOTON_IMESSAGE_TOKEN: '' }
    const missing = await run(BIN, ['chats', '--json'], { env }).catch((error: { stderr: string }) => error)
    expect(JSON.parse(missing.stderr)).toEqual({ error: { code: 400, message: expect.stringContaining('PHOTON_IMESSAGE_ADDRESS') } })
    const serve = await run(BIN, ['serve'], { env }).catch((error: { stderr: string }) => error)
    expect(JSON.parse(serve.stderr).error.code).toBe(400)
  })
})
