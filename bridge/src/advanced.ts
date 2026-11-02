/**
 * The four bridge commands in advanced mode, over Photon's Advanced iMessage server (gRPC): the same JSON as local mode
 * (`bridge.ts`), so the iMessage Source cannot tell the modes apart. The server keeps the line's history and a durable
 * event log, so unlike cloud mode nothing runs beside the service and nothing is kept on disk: `pull` replays the log after
 * its cursor, and a reply's key becomes the server's `clientMessageId`, which deduplicates sends across restarts.
 */
import { createHash } from 'node:crypto'
import type { ChatsResource, EventsResource, Message, MessagesResource } from '@photon-ai/advanced-imessage/grpc'
import { BridgeError, PULL_LIMIT, formatCursor, parseCursor, type BridgeMessage } from './bridge.ts'

/** What the bridge needs of the Advanced iMessage client: the calls of `createClient(...)` it uses. */
export interface AdvancedPort {
  readonly events: Pick<EventsResource, 'catchUp'>
  readonly messages: Pick<MessagesResource, 'listInChat' | 'listRecent' | 'sendText'>
  readonly chats: Pick<ChatsResource, 'get'>
}
/** The server lists at most this many messages per page. */
const PAGE_MAX = 100

/** A chat guid names its kind: `any;-;<handle>` is a direct chat, `any;+;<id>` a group. */
export function kindOf(chatGuid: string): BridgeMessage['chatKind'] {
  return chatGuid.includes(';+;') ? 'group' : chatGuid.includes(';-;') ? 'dm' : 'unknown'
}
/** Messages the Source should see: plain messages, not Tapbacks, membership changes or retracted messages. */
const readable = (message: Message): boolean =>
  message.itemType === 'normal' && !message.reaction && !message.reactionTargetGuid && !message.dateRetracted

function toBridge(message: Message, rowId: number, chatGuid = message.chatGuids[0] ?? ''): BridgeMessage {
  const name = message.groupTitle
  return {
    id: message.guid, rowId, chatId: chatGuid, chatKind: kindOf(chatGuid), ...name ? { chatName: name } : {},
    sender: message.isFromMe ? '' : message.sender?.address ?? '', fromMe: message.isFromMe,
    // A Focus auto-reply or a system row is not a person speaking, so it can never authorize work.
    bot: message.isAutoReply || message.isSystemMessage || message.isServiceMessage,
    text: message.content.text ?? '', at: message.dateCreated.toISOString(),
    ...message.replyTargetGuid ? { replyTo: message.replyTargetGuid } : {},
  }
}

/**
 * Messages after the cursor, oldest first, and the cursor to continue from. The cursor's `rowId` is the server's event
 * sequence, so messages that arrived while the service was down come on the next pull. Without a cursor it answers no
 * messages and a cursor at the log's head, so a new deployment starts at the present instead of replaying the line's history.
 */
export async function advancedPull(port: AdvancedPort, after: string | undefined, now = Date.now()): Promise<{ items: BridgeMessage[]; next: string }> {
  const cursor = after ? parseCursor(after) : undefined
  const stream = port.events.catchUp(cursor?.rowId)
  const items: BridgeMessage[] = []
  let sequence = cursor?.rowId ?? 0
  let at = cursor?.at ?? now
  try {
    for await (const event of stream) {
      if (event.type === 'catchup.complete') {
        // A fresh cursor starts at the head; a resumed one has already taken every event up to it.
        if (!cursor) sequence = Math.max(sequence, event.headSequence)
        break
      }
      sequence = event.sequence
      if (!cursor || event.type !== 'message.received' || !readable(event.message)) continue
      items.push(toBridge(event.message, event.sequence, event.chatGuid || undefined))
      at = Math.max(at, event.message.dateCreated.getTime())
      if (items.length >= PULL_LIMIT) break
    }
  } finally { await stream.close() }
  return { items, next: formatCursor({ rowId: sequence, at }) }
}

/** The server's idempotency key for a reply key: stable for the key, and in the shape of a UUID whatever the key looks like. */
export function clientMessageId(key: string): string {
  const hex = createHash('sha256').update(`imsg-bridge:${key}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code

/**
 * Sends `text` into `chatId` once per `key`: the server rejects a repeated `clientMessageId` as a duplicate, which means the
 * first send went through, so a retry after a crash neither loses the reply nor posts it twice.
 */
export async function advancedReply(port: AdvancedPort, chatId: string, key: string, text: string): Promise<{ status: 'sent'; duplicate?: true }> {
  if (!text.trim()) throw new BridgeError('Empty reply text', 400)
  try {
    await port.messages.sendText(chatId, text, { clientMessageId: clientMessageId(key) })
    return { status: 'sent' }
  } catch (error) {
    if (codeOf(error) === 'duplicateMessage') return { status: 'sent', duplicate: true }
    if (codeOf(error) === 'chatNotFound') throw new BridgeError(`Chat not found on this line: ${chatId}`, 410)
    throw error
  }
}

/**
 * A page of one chat, oldest first: the `limit` newest messages before `before` (an ISO time; the present when omitted), and
 * `next`, the time to read the older page from, while older messages may remain.
 */
export async function advancedThread(port: AdvancedPort, chatId: string, limit: number, before?: string): Promise<{ items: BridgeMessage[]; next?: string }> {
  const until = before ? Date.parse(before) : undefined
  if (until !== undefined && !Number.isFinite(until)) throw new BridgeError(`Unreadable time: ${before}`, 400)
  const page = await port.messages.listInChat(chatId, { pageSize: Math.min(limit, PAGE_MAX), ...until !== undefined ? { before: new Date(until) } : {} })
  const rows = [...page.messages].sort((a, b) => a.dateCreated.getTime() - b.dateCreated.getTime())
  // (Listed messages carry no event sequence; the Source orders a thread by time, so 0 stands in.)
  const items = rows.filter(readable).map(message => toBridge(message, 0, chatId))
  const oldest = rows[0]
  return { items, ...page.nextPageToken && oldest ? { next: oldest.dateCreated.toISOString() } : {} }
}

/**
 * The chats on the line, most recent first, for the Source's chat picker. The server has no chat listing, so they come from
 * the newest messages; a group without a title in its messages takes the chat's display name.
 */
export async function advancedChats(port: AdvancedPort, pages = 2): Promise<{ chatId: string; name: string | null; kind: string }[]> {
  const chats = new Map<string, { chatId: string; name: string | null; kind: string }>()
  let pageToken: string | undefined
  for (let page = 0; page < pages; page++) {
    const { messages, nextPageToken } = await port.messages.listRecent({ pageSize: PAGE_MAX, ...pageToken ? { pageToken } : {} })
    for (const message of [...messages].sort((a, b) => b.dateCreated.getTime() - a.dateCreated.getTime())) {
      for (const chatId of message.chatGuids) {
        const known = chats.get(chatId)
        if (!known) chats.set(chatId, { chatId, name: message.groupTitle || null, kind: kindOf(chatId) })
        else if (!known.name && message.groupTitle) known.name = message.groupTitle
      }
    }
    if (!nextPageToken) break
    pageToken = nextPageToken
  }
  for (const chat of chats.values()) {
    if (chat.kind === 'group' && !chat.name) chat.name = (await port.chats.get(chat.chatId)).displayName || null
  }
  return [...chats.values()]
}
