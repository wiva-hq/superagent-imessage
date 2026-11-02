import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, type Assessor, type Executor, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import {
  imessageKind, imessageParent, imessageThreadContext, imessageTrigger, imessageTriggerId, normalizeHandle, plainText, pollImessage,
  runImessage, sendImessage, type ImessageConfig,
} from '../src/sources/imessage.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testDeployment } from './fixtures/deployment.ts'

const ALICE = '+15550102000'
const message = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, chatId: `iMessage;-;${ALICE}`, chatKind: 'dm', sender: ALICE, fromMe: false, text: 'fix issue #12', at: '2026-11-01T07:00:00.000Z', ...overrides,
})
const GROUP = 'iMessage;+;chat8812'
const config = (overrides: Partial<ImessageConfig> = {}): ImessageConfig => imessageKind.schema.parse(overrides)

function host(sourceConfig: Record<string, unknown> = { directMessages: true, chats: [{ chatId: GROUP, listen: 'mentions' }] }, overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'imessage-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    eval: { mode: 'auto' },
    sources: { imessage: { enabled: true, config: sourceConfig } },
    policy: { sources: { imessage: { allowed: [{ id: ALICE, name: 'Alice' }] } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(imessageKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  // `withSignal` returns a new Commands, so the stubbed `run` must be the one every call reaches.
  vi.spyOn(commands, 'withSignal').mockReturnValue(commands)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: outgoing => { store.receipts.add(outgoing) } }, commands, sources,
    deployment: testDeployment(), ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const ctx = sourceContextOf(deps, imessageKind)
  return { ctx, store, sources, commands, receive, health: board.all, deps }
}
/** Stubs `imsg-bridge` and records each call's arguments. */
function bridge(commands: Commands, answer: (args: string[]) => unknown): string[][] {
  const calls: string[][] = []
  vi.spyOn(commands, 'run').mockImplementation(async (_program, args) => { calls.push(args); return JSON.stringify(answer(args)) })
  return calls
}

afterEach(() => { vi.restoreAllMocks(); delete process.env.IMSG_BRIDGE_CLI })

describe('iMessage translation', () => {
  it('turns a direct message into a direct Trigger from the normalized handle, in the chat\'s one Thread', () => {
    const trigger = imessageTrigger(message('G1', { sender: '+1 (555) 010-2000' }), ['@agent'])!
    expect(trigger).toMatchObject({ id: imessageTriggerId('G1'), source: 'imessage', addressed: 'direct', human: true,
      actor: { source: 'imessage', id: ALICE }, threads: [{ source: 'imessage', id: `iMessage;-;${ALICE}` }],
      channel: { thread: `imessage:iMessage;-;${ALICE}`, address: { chatId: `iMessage;-;${ALICE}`, messageId: 'G1', direct: 'true' } },
      meta: { direct: true, mentioned: false } })
  })
  it('marks a group message as a mention only when it contains a wake word', () => {
    const group = { chatId: GROUP, chatKind: 'group', chatName: 'Acme team' }
    expect(imessageTrigger(message('G2', { ...group, text: 'hey @Agent look at CI' }), ['@agent'])).toMatchObject({ addressed: 'mention', meta: { chatName: 'Acme team' } })
    expect(imessageTrigger(message('G3', { ...group, text: 'lunch?' }), ['@agent'])?.addressed).toBeUndefined()
  })
  it('produces no Trigger for the agent\'s own messages, and never lets an automatic reply count as a person', () => {
    expect(imessageTrigger(message('G4', { fromMe: true, sender: '' }), [])).toBeUndefined()
    expect(imessageTrigger(message('G5', { bot: true }), [])?.human).toBe(false)
  })
  it('refuses an unreadable time instead of inventing one', () => {
    expect(() => imessageTrigger(message('G6', { at: 'yesterday' }), [])).toThrow('Unreadable iMessage time')
  })
  it('names the replied-to message\'s Trigger', () => {
    expect(imessageParent(imessageTrigger(message('G7', { replyTo: 'G1' }), [])!)).toBe(imessageTriggerId('G1'))
    expect(imessageKind.repliesTo!(imessageTrigger(message('G8'), [])!)).toBeUndefined()
  })
  it('normalizes handles: phone numbers lose their punctuation, emails their case', () => {
    expect(normalizeHandle(' +1 555.010-2000 ')).toBe(ALICE)
    expect(normalizeHandle('Ash@Example.COM')).toBe('ash@example.com')
  })
  it('flattens the agent\'s Markdown into plain text', () => {
    expect(plainText('## Done\n**PR #31** is ready: [PR #31](https://github.com/acme/app/pull/31)\n- CI `green`'))
      .toBe('Done\nPR #31 is ready: PR #31 https://github.com/acme/app/pull/31\n• CI green')
  })
})

describe('iMessage scope and Policy', () => {
  it('receives no direct messages by default, because anyone can text an Apple ID', () => {
    expect(imessageKind.scope!({ meta: { direct: true } }, config())).toEqual({ listened: false, reason: 'direct_messages_not_allowed' })
    expect(imessageKind.scope!({ meta: { direct: true } }, config({ directMessages: true }))).toEqual({ listened: true, observed: false, row: 'direct' })
  })
  it('receives listed group chats by their setting and other chats only on a wake word when allowed', () => {
    const chats = config({ chats: [{ chatId: GROUP, listen: 'all' }], otherChats: 'mentions' })
    expect(imessageKind.scope!({ meta: { chatId: GROUP } }, chats)).toEqual({ listened: true, observed: true, row: GROUP })
    expect(imessageKind.scope!({ meta: { chatId: 'chat9', mentioned: true } }, chats)).toEqual({ listened: true, observed: false, row: 'other' })
    expect(imessageKind.scope!({ meta: { chatId: 'chat9', mentioned: false } }, chats).listened).toBe(false)
  })
  it('replies only into chats the Source still receives', () => {
    const allowed = imessageKind.channel!.allowed!
    expect(allowed({ chatId: `iMessage;-;${ALICE}`, direct: 'true' }, config())).toBe(false)
    expect(allowed({ chatId: `iMessage;-;${ALICE}`, direct: 'true' }, config({ directMessages: true }))).toBe(true)
    expect(allowed({ chatId: GROUP }, config({ chats: [{ chatId: GROUP, listen: 'mentions' }] }))).toBe(true)
  })
  it('stores allowed handles normalized and refuses what is neither a phone number nor an email', () => {
    const { sources } = host()
    expect(sources.validatePolicy({ imessage: { allowed: [{ id: '+1 555 010 2000'.replace(/ /g, '') }, { id: 'Ash@Example.org' }] } }).imessage!.allowed)
      .toEqual([{ id: ALICE }, { id: 'ash@example.org' }])
    expect(() => sources.validatePolicy({ imessage: { allowed: [{ id: '5550102000' }] } })).toThrow()
  })
  it('lists its admission rows with the cells each scope can observe', () => {
    const rows = imessageKind.policy!.rows!({ chats: [{ chatId: GROUP, name: 'Team', listen: 'mentions' }], directMessages: true })
    expect(rows.map(row => [row.id, row.cells])).toEqual([
      [GROUP, { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false }],
      ['other', { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false }],
      ['direct', { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false }],
    ])
  })
})

describe('iMessage poll', () => {
  it('starts at the present without a cursor, then continues after the cursor the bridge returned', async () => {
    const h = host()
    const calls = bridge(h.commands, args => args.includes('--after') ? { items: [message('G1')], next: 'c2' } : { items: [], next: 'c1' })
    await pollImessage(h.ctx, config({ directMessages: true }), new AbortController().signal)
    expect(h.store.get(KV.imessage.cursor)).toBe('c1')
    const result = await pollImessage(h.ctx, config({ directMessages: true }), new AbortController().signal)
    expect(calls).toEqual([['pull', '--json'], ['pull', '--json', '--after', 'c1']])
    expect(result).toEqual({ read: 1, unreadable: 0 })
    expect(h.store.get(KV.imessage.cursor)).toBe('c2')
    expect(h.store.triggers.get(imessageTriggerId('G1'))).toMatchObject({ addressed: 'direct', actor: { id: ALICE } })
    expect(h.store.triggers.disposition(imessageTriggerId('G1'))?.filtered).toBeUndefined()
    expect(h.store.threads.get(`imessage:iMessage;-;${ALICE}`)?.meta.label).toBe(`iMessage ${ALICE}`)
  })
  it('counts an unreadable item and keeps reading the rest; replaying a page creates nothing new', async () => {
    const h = host()
    bridge(h.commands, () => ({ items: [{ id: 'broken' }, message('G2'), message('G3', { fromMe: true, sender: '' })], next: 'c9' }))
    expect(await pollImessage(h.ctx, config({ directMessages: true }), new AbortController().signal)).toEqual({ read: 3, unreadable: 1 })
    expect(h.receive).toHaveBeenCalledTimes(1)
    await pollImessage(h.ctx, config({ directMessages: true }), new AbortController().signal)
    expect(await h.receive.mock.results[1]!.value).toBe('duplicate')
  })
  it('keeps out-of-scope messages as filtered, so the panel can say why', async () => {
    const h = host({ directMessages: false })
    bridge(h.commands, () => ({ items: [message('G4')], next: 'c1' }))
    await pollImessage(h.ctx, config(), new AbortController().signal)
    expect(h.store.triggers.disposition(imessageTriggerId('G4'))?.filtered).toBeDefined()
  })
  it('does not move the cursor when the bridge answer is unreadable', async () => {
    const h = host()
    h.store.set(KV.imessage.cursor, 'c1')
    vi.spyOn(h.commands, 'run').mockResolvedValue('not json')
    await expect(pollImessage(h.ctx, config(), new AbortController().signal)).rejects.toThrow()
    expect(h.store.get(KV.imessage.cursor)).toBe('c1')
  })
  it('uses IMSG_BRIDGE_CLI when it is set', async () => {
    const h = host()
    process.env.IMSG_BRIDGE_CLI = '/opt/imsg/bin/imsg-bridge'
    const run = vi.spyOn(h.commands, 'run').mockResolvedValue(JSON.stringify({ items: [], next: 'c1' }))
    await pollImessage(h.ctx, config(), new AbortController().signal)
    expect(run.mock.calls[0]![0]).toBe('/opt/imsg/bin/imsg-bridge')
  })
  it('waits for setup before reading anything', async () => {
    const h = host(undefined, { configured: () => false })
    const run = vi.spyOn(h.commands, 'run')
    await runImessage(h.ctx, new AbortController().signal)
    expect(run).not.toHaveBeenCalled()
    expect(h.health.imessage).toMatchObject({ state: 'paused', code: 'setupPending' })
  })
  it('reports an error only after three failed polls in a row', async () => {
    // The shortest interval keeps this test near four seconds; `node:timers/promises` is not faked by vitest's fake timers.
    const h = host({ directMessages: true, pollSeconds: 2 })
    const run = vi.spyOn(h.commands, 'run').mockRejectedValue(new Error('Messages is not running'))
    const controller = new AbortController()
    const running = runImessage(h.ctx, controller.signal)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2), { timeout: 4000 })
    expect(h.health.imessage?.state).not.toBe('error')
    await vi.waitFor(() => expect(h.health.imessage).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: '3' } }), { timeout: 4000 })
    controller.abort(); await running
  }, 10_000)
})

describe('iMessage channel and context', () => {
  const outgoing = (text = 'PR #31 is ready: **CI green**'): OutboundMessage =>
    ({ id: 'reply-1', kind: 'reply', text, channel: { source: 'imessage', thread: `imessage:${GROUP}`, address: { chatId: GROUP, messageId: 'G1' } } })
  it('replies in the chat with the message id as the idempotency key, as plain text', async () => {
    const h = host()
    const calls = bridge(h.commands, () => ({ status: 'sent' }))
    expect(await sendImessage(h.ctx, outgoing())).toBe('sent')
    expect(calls).toEqual([['reply', '--chat', GROUP, '--key', 'reply-1', '--text', 'PR #31 is ready: CI green']])
  })
  it('drops a reply to a chat that is gone and retries any other failure', async () => {
    const h = host()
    const run = vi.spyOn(h.commands, 'run').mockRejectedValueOnce(commandError({ stderr: JSON.stringify({ error: { code: 410, message: 'chat not found' } }) }))
    expect(await sendImessage(h.ctx, outgoing())).toBe('gone')
    run.mockRejectedValueOnce(commandError({ stderr: JSON.stringify({ error: { code: 500, message: 'AppleScript timed out' } }) }))
    await expect(sendImessage(h.ctx, outgoing())).rejects.toThrow('AppleScript timed out')
  })
  it('refuses a reply with no chat', async () => {
    const h = host()
    await expect(sendImessage(h.ctx, { ...outgoing(), channel: { source: 'imessage', thread: 'imessage:x', address: {} } })).rejects.toThrow('Missing iMessage reply target')
  })
  it('gives assessments a page of the chat, older pages by cursor, with the agent\'s own messages named as the agent', async () => {
    const h = host()
    const calls = bridge(h.commands, () => ({ items: [message('G0', { fromMe: true, sender: '', text: 'On it' }), message('G1', { replyTo: 'G0' })], next: 'older' }))
    const trigger = imessageTrigger(message('G1'), [])!
    const part = await imessageThreadContext.read(h.commands, trigger, 'thread', 'c5', config({ threadPageSize: 10 }))
    expect(calls).toEqual([['thread', '--chat', `iMessage;-;${ALICE}`, '--limit', '10', '--json', '--before', 'c5']])
    expect(part.messages).toEqual([
      { id: 'G0', from: 'agent', at: '2026-11-01T07:00:00.000Z', text: 'On it' },
      { id: 'G1', from: ALICE, at: '2026-11-01T07:00:00.000Z', text: 'fix issue #12', reply_to: 'G0' },
    ])
    expect(part.next).toBe('older')
    expect(imessageThreadContext.messageId(trigger)).toBe('G1')
  })
  it('refreshes chat names for the settings form', async () => {
    const h = host()
    bridge(h.commands, () => [{ chatId: GROUP, name: 'Acme team' }, { chatId: 'chat2', name: null }])
    const labels = await imessageKind.refreshLabels!({ sources: h.sources, context: kind => sourceContextOf(h.deps, kind) })
    expect(labels).toEqual({ [GROUP]: 'Acme team' })
    expect(h.store.get(KV.sources.labels('imessage'))).toEqual({ [GROUP]: 'Acme team' })
  })
  it('names the chat a Ticket started in for the Executor, and nothing for other Sources', () => {
    const values = imessageKind.environment!.values
    const trigger = imessageTrigger(message('G1'), [])!
    expect(values({ deployment: testDeployment(), config: config(), trigger })).toEqual({ DSH_SUPERAGENT_IMESSAGE_CHAT: `iMessage;-;${ALICE}` })
    expect(values({ deployment: testDeployment(), config: config(), trigger: { ...trigger, source: 'github' } })).toEqual({ DSH_SUPERAGENT_IMESSAGE_CHAT: '' })
  })
})
