/**
 * The four bridge commands over a Messages port: `pull`, `reply`, `thread` and `chats`. They print the JSON the iMessage Source
 * reads (`src/sources/imessage-trigger.ts` in the bundle). Everything here is plain logic over the port and the ledger, so it
 * is tested without a Mac; `cli.ts` wires the port to Photon's imessage-kit.
 */
import type { Chat, ChatQuery, Message, MessageQuery, SendRequest } from '@photon-ai/imessage-kit'
import type { Ledger } from './ledger.ts'

/** What the bridge needs from Messages: the three calls of `IMessageSDK` it uses. */
export interface MessagesPort {
  getMessages(query: MessageQuery): Promise<readonly Message[]>
  listChats(query?: ChatQuery): Promise<readonly Chat[]>
  send(request: SendRequest): Promise<void>
}
/** A failure the Source reads from stderr as `{"error":{"code","message"}}`; 410 means the chat can never receive a reply. */
export class BridgeError extends Error {
  readonly code: number
  constructor(message: string, code: number) { super(message); this.code = code }
}
/** One message as the Source reads it. */
export interface BridgeMessage {
  id: string; rowId: number; chatId: string; chatKind: 'dm' | 'group' | 'unknown'; chatName?: string
  sender: string; fromMe: boolean; bot: boolean; text: string; at: string; replyTo?: string
}
/** How far back a pull looks behind its cursor's time, for rows that land in chat.db late (WAL flushes, slow iCloud sync). */
export const LATE_MS = 5 * 60_000
/** Most messages one pull returns; the rest come on the next pull, oldest first, so nothing is skipped. */
export const PULL_LIMIT = 200

/** The read position: the last row taken and the time it was written. `rowId` orders rows; `at` bounds the query. */
export interface Cursor { rowId: number; at: number }
export const formatCursor = (cursor: Cursor): string => `${cursor.rowId}@${new Date(cursor.at).toISOString()}`
export function parseCursor(value: string): Cursor {
  const match = /^(\d+)@(.+)$/.exec(value)
  const at = match ? Date.parse(match[2]!) : Number.NaN
  if (!match || !Number.isFinite(at)) throw new BridgeError(`Unreadable cursor: ${value}`, 400)
  return { rowId: Number(match[1]), at }
}

function toBridge(message: Message, chatId: string, names: ReadonlyMap<string, string>): BridgeMessage {
  const name = names.get(chatId)
  return {
    id: message.id, rowId: message.rowId, chatId, chatKind: message.chatKind, ...name ? { chatName: name } : {},
    sender: message.isFromMe ? '' : message.participant ?? '', fromMe: message.isFromMe,
    // A Focus auto-reply or a system row is not a person speaking, so it can never authorize work.
    bot: message.isAutoReply || message.isSystem, text: message.text ?? '', at: message.createdAt.toISOString(),
    ...message.replyToMessageId ? { replyTo: message.replyToMessageId } : {},
  }
}
/** Rows the Source should see: plain messages, not Tapbacks, membership changes or retracted messages. */
const readable = (message: Message): boolean => message.kind === 'text' && !message.reaction && !message.retractedAt

async function chatNames(port: MessagesPort): Promise<Map<string, string>> {
  const chats = await port.listChats({ kind: 'group', sortBy: 'recent', limit: 500 })
  return new Map(chats.flatMap(chat => chat.name ? [[chat.chatId, chat.name] as const] : []))
}

/**
 * Messages after the cursor, oldest first, and the cursor to continue from. Without a cursor it answers no messages and a
 * cursor at the newest row, so a new deployment starts at the present instead of replaying the account's history.
 * A row whose chat is not yet known (chat.db has not joined it yet) ends the page before it, so the next pull retries it.
 */
export async function pull(port: MessagesPort, after: string | undefined, now = Date.now()): Promise<{ items: BridgeMessage[]; next: string }> {
  if (!after) {
    const [newest] = await port.getMessages({ limit: 1 })
    return { items: [], next: formatCursor({ rowId: newest?.rowId ?? 0, at: now }) }
  }
  const cursor = parseCursor(after)
  const rows = (await port.getMessages({ since: new Date(cursor.at - LATE_MS) }))
    .filter(message => message.rowId > cursor.rowId).sort((a, b) => a.rowId - b.rowId)
  const page: Message[] = []
  for (const row of rows) {
    if (page.length >= PULL_LIMIT || !row.chatId || (row.hasAttachments && row.attachments.length === 0 && !row.text)) break
    page.push(row)
  }
  const last = page.at(-1)
  const next = last ? { rowId: last.rowId, at: Math.max(cursor.at, last.createdAt.getTime()) } : cursor
  const names = page.some(row => row.chatKind === 'group') ? await chatNames(port) : new Map<string, string>()
  return { items: page.filter(readable).map(row => toBridge(row, row.chatId!, names)), next: formatCursor(next) }
}

/**
 * Sends `text` into `chatId` once per `key`. The ledger records the key as pending before the send and as sent after it; a
 * key left pending (the process died mid-send) counts as sent when the agent's own message with the same text is already in
 * the chat, and is sent again otherwise.
 */
export async function reply(port: MessagesPort, ledger: Ledger, chatId: string, key: string, text: string, now = Date.now()): Promise<{ status: 'sent'; duplicate?: true }> {
  if (!text.trim()) throw new BridgeError('Empty reply text', 400)
  const entry = ledger.get(key)
  if (entry?.state === 'sent') return { status: 'sent', duplicate: true }
  if (entry?.state === 'pending') {
    const mine = await port.getMessages({ chatId, isFromMe: true, since: new Date(entry.at - 60_000) })
    if (mine.some(message => (message.text ?? '').trim() === text.trim())) {
      ledger.set(key, { ...entry, state: 'sent' })
      return { status: 'sent', duplicate: true }
    }
  }
  const [chat] = await port.listChats({ chatId, limit: 1 })
  if (!chat) throw new BridgeError(`Chat not found on this account: ${chatId}`, 410)
  ledger.set(key, { state: 'pending', chatId, at: now })
  await port.send({ to: chat.chatId, text })
  ledger.set(key, { state: 'sent', chatId, at: now })
  return { status: 'sent' }
}

/**
 * A page of one chat, oldest first: the `limit` newest messages before `before` (an ISO time; the present when omitted), and
 * `next`, the time to read the older page from, while older messages may remain.
 */
export async function thread(port: MessagesPort, chatId: string, limit: number, before?: string): Promise<{ items: BridgeMessage[]; next?: string }> {
  const until = before ? Date.parse(before) : undefined
  if (until !== undefined && !Number.isFinite(until)) throw new BridgeError(`Unreadable time: ${before}`, 400)
  const rows = await port.getMessages({ chatId, excludeReactions: true, limit, ...until !== undefined ? { before: new Date(until) } : {} })
  const page = [...rows].sort((a, b) => a.rowId - b.rowId)
  const names = page.some(row => row.chatKind === 'group') ? await chatNames(port) : new Map<string, string>()
  const items = page.filter(readable).map(row => toBridge(row, row.chatId ?? chatId, names))
  const oldest = page[0]
  return { items, ...rows.length >= limit && oldest ? { next: oldest.createdAt.toISOString() } : {} }
}

/** The chats on the agent's account, most recent first, for the Source's chat picker. */
export async function chats(port: MessagesPort): Promise<{ chatId: string; name: string | null; kind: string }[]> {
  return (await port.listChats({ sortBy: 'recent', limit: 200 })).map(chat => ({ chatId: chat.chatId, name: chat.name, kind: chat.kind }))
}
