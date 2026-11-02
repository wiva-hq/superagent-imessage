/**
 * The four bridge commands in cloud mode, over the journal and a sender: the same JSON as local mode
 * (`bridge.ts`), so the iMessage Source cannot tell the modes apart.
 */
import { BridgeError, PULL_LIMIT, formatCursor, parseCursor, type BridgeMessage } from './bridge.ts'
import type { Journal } from './journal.ts'
import type { Ledger } from './ledger.ts'

/** Sends through `imsg-bridge serve`, which holds the Spectrum connection; answers the sent message's id. */
export interface CloudSender { send(chatId: string, text: string): Promise<{ id: string }> }

/** Like local mode, a first pull without a cursor starts after the newest entry instead of replaying the journal. */
export function cloudPull(journal: Journal, after: string | undefined, now = Date.now()): { items: BridgeMessage[]; next: string } {
  const entries = journal.all()
  if (!after) return { items: [], next: formatCursor({ rowId: entries.at(-1)?.rowId ?? 0, at: now }) }
  const cursor = parseCursor(after)
  const items = entries.filter(entry => entry.rowId > cursor.rowId).slice(0, PULL_LIMIT)
  const last = items.at(-1)
  return { items, next: formatCursor(last ? { rowId: last.rowId, at: Math.max(cursor.at, Date.parse(last.at)) } : cursor) }
}

export function cloudThread(journal: Journal, chatId: string, limit: number, before?: string): { items: BridgeMessage[]; next?: string } {
  const until = before ? Date.parse(before) : Number.POSITIVE_INFINITY
  if (!Number.isFinite(until) && before) throw new BridgeError(`Unreadable time: ${before}`, 400)
  const earlier = journal.all().filter(entry => entry.chatId === chatId && Date.parse(entry.at) < until)
  const items = earlier.slice(-limit)
  return { items, ...earlier.length > limit && items[0] ? { next: items[0].at } : {} }
}

/** The chats the journal has seen, most recent first; a group keeps the newest name any of its messages carried. */
export function cloudChats(journal: Journal): { chatId: string; name: string | null; kind: string }[] {
  const chats = new Map<string, { chatId: string; name: string | null; kind: string }>()
  for (const entry of journal.all().reverse()) {
    const known = chats.get(entry.chatId)
    if (!known) chats.set(entry.chatId, { chatId: entry.chatId, name: entry.chatName ?? null, kind: entry.chatKind })
    else if (!known.name && entry.chatName) known.name = entry.chatName
  }
  return [...chats.values()]
}

/**
 * Sends once per key, as local mode does. A key left pending by a crash counts as sent when the journal holds the agent's
 * message with that text in that chat since the key was started. A chat the journal never saw answers 410: Spectrum's
 * shared lines cannot open a conversation with someone who has not texted the line first.
 */
export async function cloudReply(journal: Journal, sender: CloudSender, ledger: Ledger, chatId: string, key: string, text: string,
  now = Date.now()): Promise<{ status: 'sent'; duplicate?: true }> {
  if (!text.trim()) throw new BridgeError('Empty reply text', 400)
  const entry = ledger.get(key)
  if (entry?.state === 'sent') return { status: 'sent', duplicate: true }
  const entries = journal.all()
  if (entry?.state === 'pending' && entries.some(item => item.chatId === chatId && item.fromMe && item.text.trim() === text.trim()
    && Date.parse(item.at) >= entry.at - 60_000)) {
    ledger.set(key, { ...entry, state: 'sent' })
    return { status: 'sent', duplicate: true }
  }
  if (!entries.some(item => item.chatId === chatId)) throw new BridgeError(`Chat not seen on this line: ${chatId}`, 410)
  ledger.set(key, { state: 'pending', chatId, at: now })
  await sender.send(chatId, text)
  ledger.set(key, { state: 'sent', chatId, at: now })
  return { status: 'sent' }
}
