/**
 * iMessage Source kind and plugin entry: polls the `imsg-bridge` CLI (Photon imessage-kit on the agent's Mac), turns messages
 * into Triggers, replies in the original chat, and gives assessments the chat around a Trigger.
 */
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { threadKey, type Trigger } from '../core/index.ts'
import { validItems } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { ContextMessage, SourceKind, ThreadContext } from './kind.ts'
import { bridgeCli, imessageLink, sendImessage } from './imessage-channel.ts'
import {
  BridgeMessageSchema, PullPageSchema, SOURCE, ThreadPageSchema, imessageTrigger, imessageTriggerId, mentionWords, normalizeHandle,
} from './imessage-trigger.ts'

export { SOURCE, imessageParent, imessageTrigger, imessageTriggerId, normalizeHandle, plainText } from './imessage-trigger.ts'
export { sendImessage } from './imessage-channel.ts'

const HANDLE = /^(\+[0-9]{6,15}|[^@\s]+@[^@\s]+\.[^@\s]+)$/
const ConfigSchema = z.object({
  chats: z.array(z.object({ chatId: z.string().regex(/^\S{1,200}$/), name: z.string().trim().max(60).optional(), listen: z.enum(['mentions', 'all']) }).strict())
    .refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs').default([]),
  // Anyone can text an Apple ID, so direct messages stay off until the operator turns them on; the allowed list still decides who may originate work.
  directMessages: z.boolean().default(false),
  otherChats: z.enum(['none', 'mentions']).default('none'),
  mention: z.string().trim().max(200).default('@agent'),
  pollSeconds: z.number().int().min(2).max(300).default(5),
  threadPageSize: z.number().int().min(1).max(50).default(20),
}).strict()
export type ImessageConfig = z.infer<typeof ConfigSchema>
const ChatsSchema = z.array(z.looseObject({ chatId: z.string(), name: z.string().nullish() }))

/** A chat page as assessments read it; iMessage chats are flat, so the root and the parent are on the Thread's pages, as on GitHub. */
export const imessageThreadContext: ThreadContext<ImessageConfig> = {
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  async read(commands, trigger, _part, cursor, config) {
    const args = ['thread', '--chat', String(trigger.meta.chatId ?? ''), '--limit', String(config.threadPageSize), '--json', ...cursor ? ['--before', cursor] : []]
    const page = ThreadPageSchema.parse(JSON.parse(await commands.run(bridgeCli(), args)))
    const messages: ContextMessage[] = validItems(BridgeMessageSchema, page.items).map(item => ({
      id: item.id, from: item.fromMe ? 'agent' : normalizeHandle(item.sender), at: item.at, text: item.text,
      ...item.bot ? { bot: true as const } : {}, ...item.replyTo ? { reply_to: item.replyTo } : {} }))
    return { messages, ...page.next ? { next: page.next } : {}, body: { messages } }
  },
}

export const imessageKind: SourceKind<ImessageConfig> = {
  kind: SOURCE,
  title: { zh: 'iMessage', en: 'iMessage' },
  description: { zh: '通过 imsg-bridge 接收下列 iMessage 群和私聊里发给智能体的消息，并在原对话里回复。', en: 'Receives messages to the agent in these iMessage chats and direct messages through imsg-bridge, and replies in the original chat.' },
  schema: ConfigSchema,
  fields: [
    { key: 'chats', type: 'rows', label: { zh: '接收的群', en: 'Group chats' },
      hint: { zh: '“仅 @”只接收含唤醒词的消息；“全部消息”也接收其余消息，评估可以按规则从中推断工作。', en: '"@ only" receives messages that contain a wake word; "All" also receives the rest, from which Eval may infer work under the rules.' },
      columns: [
        { key: 'chatId', type: 'text', label: { zh: '群', en: 'Chat' }, pattern: '\\S{1,200}', choose: { zh: '选择智能体账号里的群', en: 'Choose a chat on the agent\'s account' }, refresh: { zh: '刷新群列表', en: 'Refresh chats' } },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
      ] },
    { key: 'otherChats', type: 'select', label: { zh: '其他群', en: 'Other chats' }, options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }] },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' },
      hint: { zh: '任何人都能给智能体的 Apple ID 发消息，所以默认关闭；打开后谁能发起工作仍由策略名单决定。', en: 'Anyone can text the agent\'s Apple ID, so this is off by default; once on, the Policy\'s list still decides who may originate work.' } },
    { key: 'mention', type: 'text', label: { zh: '群里的唤醒词', en: 'Wake words in group chats' },
      hint: { zh: '逗号分隔，不区分大小写。iMessage 没有 @ 机器人，群消息含其中一个词就算点名智能体。', en: 'Comma-separated, case-insensitive. iMessage has no bot mentions, so a group message containing one of these words addresses the agent.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 2, max: 300, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'threadPageSize', type: 'number', advanced: true, min: 1, max: 50, label: { zh: '每页消息数', en: 'Messages per page' } },
  ],
  health: ['imessage'],
  scope({ meta }, config) {
    if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const chat = config.chats.find(item => item.chatId === meta.chatId)
    if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
    return config.otherChats === 'mentions' && meta.mentioned === true ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_allowed' }
  },
  channel: {
    // A reply goes only to a chat the Source still receives; `mentioned` is true here because a reply in an "@ only" chat answers someone who addressed the agent.
    allowed: (address, config) => imessageKind.scope!({ meta: { chatId: address.chatId ?? '', direct: address.direct === 'true', mentioned: true } }, config).listened,
    send: sendImessage, link: imessageLink,
  },
  threadContext: imessageThreadContext,
  repliesTo: trigger => typeof trigger.meta.replyTo === 'string' ? imessageTriggerId(trigger.meta.replyTo) : undefined,
  async refreshLabels(host, signal) {
    const ctx = sourceContext(host, imessageKind)
    const chats = ChatsSchema.parse(JSON.parse(await ctx.commands.withSignal(signal).run(bridgeCli(), ['chats', '--json'])))
    const labels = Object.fromEntries(chats.flatMap(chat => chat.name ? [[chat.chatId, chat.name]] : []))
    ctx.state.set(KV.sources.labels(SOURCE), labels)
    return labels
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(HANDLE).transform(normalizeHandle), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate handles').default([]),
    }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的人', en: 'People who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '手机号（+1…）或 Apple ID 邮箱', en: 'Phone (+1…) or Apple ID email' }, pattern: HANDLE.source.slice(1, -1) },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单内的人私聊智能体，或在群里说唤醒词。', en: 'Someone on the list messages the agent directly, or says a wake word in a group chat.' },
    rows(stored) {
      const config = ConfigSchema.parse(stored)
      const mentioned = { zh: '仅 @', en: '@ only' }
      return [
        ...config.chats.map(chat => ({ id: chat.chatId, label: chat.name || chat.chatId, note: chat.listen === 'all' ? { zh: '全部消息', en: 'All' } : mentioned,
          cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' } })),
        { id: 'other', label: { zh: '其他群', en: 'Other chats' }, note: config.otherChats === 'mentions' ? mentioned : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_IMESSAGE_CHAT', description: {
      zh: '接下工单的 iMessage 对话；工单不是从 iMessage 来的时为空', en: 'The iMessage chat that started the ticket; empty when the ticket did not start on iMessage' } }],
    values: ({ trigger }) => ({ DSH_SUPERAGENT_IMESSAGE_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '' }),
  },
}

/**
 * Reads the bridge after the cursor, takes in each message, then moves the cursor past them. Without a cursor the bridge
 * starts at the present, so turning the Source on never replays a chat history as requests.
 */
export async function pollImessage(ctx: SourceContext, config: ImessageConfig, signal: AbortSignal): Promise<{ read: number; unreadable: number }> {
  const after = ctx.state.get(KV.imessage.cursor)
  const output = await ctx.commands.withSignal(signal).run(bridgeCli(), ['pull', '--json', ...after ? ['--after', after] : []])
  const page = PullPageSchema.parse(JSON.parse(output))
  const words = mentionWords(config.mention)
  let unreadable = 0
  for (const item of page.items) {
    if (signal.aborted) throw new Error('The iMessage Source stopped during the read')
    let trigger: Trigger | undefined
    try { trigger = imessageTrigger(item, words) }
    catch { unreadable++; continue }
    if (!trigger) continue
    await ctx.receive(trigger)
    const name = typeof trigger.meta.chatName === 'string' ? trigger.meta.chatName : undefined
    for (const ref of trigger.threads) {
      ctx.threads.describe(threadKey(ref), { label: name ?? (trigger.meta.direct === true ? `iMessage ${trigger.actor.id}` : `iMessage ${ref.id}`) })
    }
  }
  ctx.state.set(KV.imessage.cursor, page.next)
  return { read: page.items.length, unreadable }
}

export async function runImessage(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then the Source reads nothing.
  if (!ctx.configured()) { ctx.report('imessage', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<ImessageConfig>(SOURCE)
    if (!config) ctx.report('imessage', health('paused', 'sourceOff'))
    else {
      const at = new Date().toISOString()
      try {
        const { read, unreadable } = await pollImessage(ctx, config, signal)
        failures = 0
        ctx.report('imessage', { state: 'ready', detail: unreadable ? `${read} messages, ${unreadable} unreadable` : `${read} messages`, at })
      } catch (error) {
        failures += 1
        // The bridge sits on the same Mac, so one failure is usually Messages restarting; three in a row need a person.
        if (!signal.aborted && failures >= 3) ctx.report('imessage', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
      }
    }
    await delay((config?.pollSeconds ?? 5) * 1000, undefined, { signal }).catch(() => {})
  }
}

export const name = 'dsh-superagent-imessage'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(imessageKind), 'imessage: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, imessageKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = runImessage(source, controller.signal)
      .catch((error: unknown) => { source.report('imessage', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
