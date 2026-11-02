/** Normalizes iMessage messages, as the `imsg-bridge` CLI prints them, into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'imessage'

/**
 * One message as `imsg-bridge pull`, `imsg-bridge thread` and `imsg-bridge message` print it. `sender` is the remote handle
 * (a phone number or an email address) and is empty on the agent's own messages; `bot` marks automatic messages such as
 * Focus auto-replies, which can never authorize work.
 */
export const BridgeMessageSchema = z.looseObject({
  id: z.string().min(1),
  chatId: z.string().min(1),
  chatKind: z.enum(['dm', 'group', 'unknown']).default('unknown'),
  chatName: z.string().nullish(),
  sender: z.string().default(''),
  fromMe: z.boolean().default(false),
  bot: z.boolean().default(false),
  text: z.string().default(''),
  at: z.string(),
  replyTo: z.string().nullish(),
})
export type BridgeMessage = z.infer<typeof BridgeMessageSchema>
/** The answer of `imsg-bridge pull`: items are validated one by one so an unreadable item is skipped alone. */
export const PullPageSchema = z.looseObject({ items: z.array(z.unknown()).default([]), next: z.string().min(1) })
/** The answer of `imsg-bridge thread`: a page of one chat, oldest first, with `next` naming the older page. */
export const ThreadPageSchema = z.looseObject({ items: z.array(z.unknown()).default([]), next: z.string().optional() })

/**
 * The handle as the Policy's allowed list names it: email addresses in lower case, phone numbers without spaces, dashes,
 * dots or brackets, so `+1 (555) 010-2000` and `+15550102000` are the same person.
 */
export function normalizeHandle(handle: string): string {
  const trimmed = handle.trim()
  if (trimmed.includes('@')) return trimmed.toLowerCase()
  return trimmed.replace(/[\s().-]/g, '')
}
/** Words that address the agent in a group chat, from the comma-separated `mention` setting. */
export const mentionWords = (mention: string): string[] =>
  mention.split(',').map(word => word.trim().toLowerCase()).filter(Boolean)
export const mentions = (text: string, words: readonly string[]): boolean => {
  const lower = text.toLowerCase()
  return words.some(word => lower.includes(word))
}
/** Deterministic Trigger id of a message; every read path for this message produces the same id. */
export const imessageTriggerId = (messageId: string): string => key(SOURCE, messageId)
/**
 * The reply channel of a chat. iMessage has no topics, so the whole chat is one Thread: a person's follow-up in the same chat
 * ("add the Safari test too") reaches the Ticket that the chat already follows. `direct` is recorded in the address because a
 * reply's destination check reads only the address and the configuration.
 */
export const imessageChannel = (chatId: string, messageId: string, direct = false): ChannelRef =>
  ({ source: SOURCE, thread: `${SOURCE}:${chatId}`, address: { chatId, messageId, ...direct ? { direct: 'true' } : {} } })

/** Converts a bridge message into a Trigger, returning undefined for the agent's own messages. */
export function imessageTrigger(input: unknown, mention: readonly string[]): Trigger | undefined {
  const message = BridgeMessageSchema.parse(input)
  if (message.fromMe || !message.sender) return undefined
  const direct = message.chatKind === 'dm'
  const mentioned = !direct && mentions(message.text, mention)
  const at = Date.parse(message.at)
  if (!Number.isFinite(at)) throw new Error(`Unreadable iMessage time: ${message.at}`)
  return {
    id: imessageTriggerId(message.id), source: SOURCE, threads: [{ source: SOURCE, id: message.chatId }],
    actor: { source: SOURCE, id: normalizeHandle(message.sender) }, human: !message.bot,
    ...(direct ? { addressed: 'direct' as const } : mentioned ? { addressed: 'mention' as const } : {}),
    at: new Date(at).toISOString(), text: message.text,
    channel: imessageChannel(message.chatId, message.id, direct),
    meta: { chatId: message.chatId, messageId: message.id, direct, mentioned,
      ...(message.chatName ? { chatName: message.chatName } : {}), ...(message.replyTo ? { replyTo: message.replyTo } : {}) },
  }
}
export const imessageParent = (trigger: Trigger): string | undefined =>
  trigger.source === SOURCE && typeof trigger.meta.replyTo === 'string' ? imessageTriggerId(trigger.meta.replyTo) : undefined

/**
 * iMessage shows plain text, so Markdown the agent writes is flattened: `[label](url)` becomes `label url`, emphasis and
 * code marks are dropped, headings lose their hashes, and list bullets become `•`.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[a-z]*\n?([\s\S]*?)```/g, (_, code: string) => code.trimEnd())
    .replace(/!?\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => label === url ? url : `${label} ${url}`)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^(\s*)[-*]\s+/gm, '$1• ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}
