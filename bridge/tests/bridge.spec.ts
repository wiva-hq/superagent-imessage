import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chat, ChatQuery, Message, MessageQuery, SendRequest } from '@photon-ai/imessage-kit'
import { describe, expect, it } from 'vitest'
import { BridgeError, LATE_MS, PULL_LIMIT, chats, formatCursor, parseCursor, pull, reply, thread, type MessagesPort } from '../src/bridge.ts'
import { FileLedger, KEEP_MS, MemoryLedger } from '../src/ledger.ts'

const DM = 'iMessage;-;+15550102000'
const GROUP = 'iMessage;+;chat8812'
const T0 = Date.parse('2026-11-01T07:00:00.000Z')

function row(rowId: number, overrides: Partial<Message> = {}): Message {
  return { rowId, id: `G${rowId}`, chatId: DM, chatKind: 'dm', participant: '+15550102000', service: 'iMessage', text: `message ${rowId}`,
    kind: 'text', isFromMe: false, isAutoReply: false, isSystem: false, createdAt: new Date(T0 + rowId * 1000), replyToMessageId: null,
    reaction: null, retractedAt: null, hasAttachments: false, attachments: [], ...overrides } as unknown as Message
}
const chat = (chatId: string, name: string | null, kind: 'dm' | 'group' = 'group') => ({ chatId, name, kind } as unknown as Chat)

/** A Messages port over an in-memory chat.db: queries filter and order as imessage-kit's do (newest first). */
class FakeMessages implements MessagesPort {
  readonly sent: SendRequest[] = []
  readonly queries: MessageQuery[] = []
  rows: Message[]
  chatList: Chat[]
  constructor(rows: Message[] = [], chatList: Chat[] = [chat(DM, null, 'dm'), chat(GROUP, 'Acme team')]) { this.rows = rows; this.chatList = chatList }
  async getMessages(query: MessageQuery): Promise<readonly Message[]> {
    this.queries.push(query)
    const matched = this.rows.filter(message =>
      (query.chatId === undefined || message.chatId === query.chatId) && (query.isFromMe === undefined || message.isFromMe === query.isFromMe)
      && (query.since === undefined || message.createdAt >= query.since) && (query.before === undefined || message.createdAt < query.before)
      && (!query.excludeReactions || !message.reaction))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    return query.limit === undefined ? matched : matched.slice(0, query.limit)
  }
  async listChats(query: ChatQuery = {}): Promise<readonly Chat[]> {
    const matched = this.chatList.filter(item => (query.chatId === undefined || item.chatId === query.chatId) && (query.kind === undefined || item.kind === query.kind))
    return query.limit === undefined ? matched : matched.slice(0, query.limit)
  }
  async send(request: SendRequest): Promise<void> {
    this.sent.push(request)
    this.rows.push(row(1000 + this.sent.length, { chatId: request.to, isFromMe: true, participant: null, text: request.text ?? '', createdAt: new Date() }))
  }
}

describe('cursor', () => {
  it('round-trips and refuses what it did not write', () => {
    expect(parseCursor(formatCursor({ rowId: 42, at: T0 }))).toEqual({ rowId: 42, at: T0 })
    expect(() => parseCursor('42')).toThrow(BridgeError)
  })
})

describe('pull', () => {
  it('starts at the newest row without replaying history', async () => {
    const port = new FakeMessages([row(1), row(2), row(3)])
    expect(await pull(port, undefined, T0 + 10_000)).toEqual({ items: [], next: formatCursor({ rowId: 3, at: T0 + 10_000 }) })
  })
  it('answers the rows after the cursor oldest first, as the Source reads them, and looks back for late rows', async () => {
    const port = new FakeMessages([row(1), row(2), row(3, { chatId: GROUP, chatKind: 'group', replyToMessageId: 'G2' })])
    const page = await pull(port, formatCursor({ rowId: 1, at: T0 + 1000 }))
    expect(port.queries[0]!.since!.getTime()).toBe(T0 + 1000 - LATE_MS)
    expect(page.items).toEqual([
      { id: 'G2', rowId: 2, chatId: DM, chatKind: 'dm', sender: '+15550102000', fromMe: false, bot: false, text: 'message 2', at: new Date(T0 + 2000).toISOString() },
      { id: 'G3', rowId: 3, chatId: GROUP, chatKind: 'group', chatName: 'Acme team', sender: '+15550102000', fromMe: false, bot: false,
        text: 'message 3', at: new Date(T0 + 3000).toISOString(), replyTo: 'G2' },
    ])
    expect(parseCursor(page.next)).toEqual({ rowId: 3, at: T0 + 3000 })
  })
  it('keeps the cursor when nothing is new', async () => {
    const cursor = formatCursor({ rowId: 3, at: T0 + 3000 })
    expect(await pull(new FakeMessages([row(1), row(2), row(3)]), cursor)).toEqual({ items: [], next: cursor })
  })
  it('passes the agent\'s own messages as fromMe, marks auto-replies as bots, and skips Tapbacks and retracted messages while moving past them', async () => {
    const port = new FakeMessages([row(2, { isFromMe: true, participant: null }), row(3, { isAutoReply: true }),
      row(4, { reaction: { kind: 'like' } as Message['reaction'] }), row(5, { retractedAt: new Date() }), row(6, { kind: 'memberAdded' })])
    const page = await pull(port, formatCursor({ rowId: 1, at: T0 }))
    expect(page.items.map(item => [item.id, item.fromMe, item.sender, item.bot])).toEqual([['G2', true, '', false], ['G3', false, '+15550102000', true]])
    expect(parseCursor(page.next).rowId).toBe(6)
  })
  it('stops before a row whose chat chat.db has not joined yet, so the next pull takes it', async () => {
    const page = await pull(new FakeMessages([row(2), row(3, { chatId: null }), row(4)]), formatCursor({ rowId: 1, at: T0 }))
    expect(page.items.map(item => item.id)).toEqual(['G2'])
    expect(parseCursor(page.next).rowId).toBe(2)
  })
  it('returns at most a page and continues from its end', async () => {
    const port = new FakeMessages(Array.from({ length: PULL_LIMIT + 5 }, (_, index) => row(index + 1)))
    const first = await pull(port, formatCursor({ rowId: 0, at: T0 }))
    expect(first.items).toHaveLength(PULL_LIMIT)
    const second = await pull(port, first.next)
    expect(second.items.map(item => item.rowId)).toEqual([201, 202, 203, 204, 205])
  })
})

describe('reply', () => {
  it('sends once per key', async () => {
    const port = new FakeMessages(); const ledger = new MemoryLedger()
    expect(await reply(port, ledger, DM, 'k1', 'PR #31 is ready')).toEqual({ status: 'sent' })
    expect(await reply(port, ledger, DM, 'k1', 'PR #31 is ready')).toEqual({ status: 'sent', duplicate: true })
    expect(port.sent).toEqual([{ to: DM, text: 'PR #31 is ready' }])
  })
  it('after a crash mid-send, counts a pending key as sent when the chat already has the agent\'s message, and sends otherwise', async () => {
    const port = new FakeMessages([row(9, { isFromMe: true, participant: null, text: 'PR #31 is ready', createdAt: new Date(T0) })])
    const ledger = new MemoryLedger()
    ledger.set('landed', { state: 'pending', chatId: DM, at: T0 })
    expect(await reply(port, ledger, DM, 'landed', 'PR #31 is ready')).toEqual({ status: 'sent', duplicate: true })
    ledger.set('lost', { state: 'pending', chatId: DM, at: T0 })
    expect(await reply(port, ledger, DM, 'lost', 'Merged into main')).toEqual({ status: 'sent' })
    expect(port.sent.map(sent => sent.text)).toEqual(['Merged into main'])
    expect(ledger.get('lost')?.state).toBe('sent')
  })
  it('answers 410 for a chat the account does not have, and 400 for empty text', async () => {
    await expect(reply(new FakeMessages(), new MemoryLedger(), 'iMessage;+;gone', 'k', 'hi')).rejects.toMatchObject({ code: 410 })
    await expect(reply(new FakeMessages(), new MemoryLedger(), DM, 'k', '  ')).rejects.toMatchObject({ code: 400 })
  })
  it('leaves the key pending when the send fails, so a retry checks before sending again', async () => {
    const port = new FakeMessages(); const ledger = new MemoryLedger()
    port.send = async () => { throw new Error('AppleScript timed out') }
    await expect(reply(port, ledger, DM, 'k', 'hi', T0)).rejects.toThrow('AppleScript timed out')
    expect(ledger.get('k')).toEqual({ state: 'pending', chatId: DM, at: T0 })
  })
})

describe('thread', () => {
  it('answers the newest messages oldest first, and the time to read older ones from', async () => {
    const port = new FakeMessages([row(1), row(2), row(3), row(4), row(5, { chatId: GROUP })])
    const page = await thread(port, DM, 2)
    expect(page.items.map(item => item.id)).toEqual(['G3', 'G4'])
    expect(page.next).toBe(new Date(T0 + 3000).toISOString())
    const older = await thread(port, DM, 2, page.next)
    expect(older.items.map(item => item.id)).toEqual(['G1', 'G2'])
    const oldest = await thread(port, DM, 2, older.next)
    expect(oldest).toEqual({ items: [] })
  })
  it('refuses an unreadable time', async () => {
    await expect(thread(new FakeMessages(), DM, 2, 'yesterday')).rejects.toMatchObject({ code: 400 })
  })
})

describe('chats', () => {
  it('lists the account\'s chats for the picker', async () => {
    expect(await chats(new FakeMessages())).toEqual([{ chatId: DM, name: null, kind: 'dm' }, { chatId: GROUP, name: 'Acme team', kind: 'group' }])
  })
})

describe('FileLedger', () => {
  it('persists entries and forgets old ones', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'nested', 'ledger.json')
    let now = T0
    const ledger = new FileLedger(path, () => now)
    expect(ledger.get('a')).toBeUndefined()
    ledger.set('a', { state: 'sent', chatId: DM, at: T0 })
    expect(new FileLedger(path).get('a')).toEqual({ state: 'sent', chatId: DM, at: T0 })
    now = T0 + KEEP_MS + 1
    ledger.set('b', { state: 'sent', chatId: DM, at: now })
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')) as object)).toEqual(['b'])
  })
})
