import { execFile } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { BridgeError, PULL_LIMIT, formatCursor, parseCursor, type BridgeMessage } from '../src/bridge.ts'
import { modeOf } from '../src/cli.ts'
import { cloudChats, cloudPull, cloudReply, cloudThread, type CloudSender } from '../src/cloud.ts'
import { FileJournal, MemoryJournal } from '../src/journal.ts'
import { MemoryLedger } from '../src/ledger.ts'
import { fromSpectrum, httpSender, readEndpoint, sendHandler, writeEndpoint, type SpectrumSpace } from '../src/serve.ts'

const run = promisify(execFile)
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'imsg-bridge')
const DM = 'any;-;+15550102000'
const GROUP = 'any;+;8812'
const T0 = Date.parse('2026-11-01T07:00:00.000Z')
const entry = (id: string, overrides: Partial<BridgeMessage> = {}): Omit<BridgeMessage, 'rowId'> => ({
  id, chatId: DM, chatKind: 'dm', sender: '+15550102000', fromMe: false, bot: false, text: `message ${id}`, at: new Date(T0).toISOString(), ...overrides,
})
const temporary = () => mkdtempSync(join(tmpdir(), 'imsg-cloud-'))
const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => { server.close(resolve) }))) })

/** A `serve` without Spectrum: the real send handler over a fake space lookup, on an ephemeral loopback port. */
async function fakeServe(journal: FileJournal | MemoryJournal, token = 'secret') {
  const sent: { chatId: string; text: string }[] = []
  const space = (id: string): SpectrumSpace => ({ id, type: id.includes(';+;') ? 'group' : 'dm',
    send: async text => { sent.push({ chatId: id, text }); return { id: `out-${sent.length}` } } })
  const server = createServer((request, response) => { void sendHandler(token, async chatId => {
    if (chatId === 'any;-;broken') throw new Error('Spectrum refused the send')
    return space(chatId)
  }, journal)(request, response) })
  servers.push(server)
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  return { port: (server.address() as AddressInfo).port, token, sent }
}

describe('journal', () => {
  it('numbers entries, keeps one per message id, and reads back what it wrote', () => {
    const journal = new FileJournal(join(temporary(), 'nested', 'journal.jsonl'))
    expect(journal.all()).toEqual([])
    expect(journal.append(entry('A')).rowId).toBe(1)
    expect(journal.append(entry('B')).rowId).toBe(2)
    expect(journal.append(entry('A', { text: 'again' })).rowId).toBe(1)
    expect(journal.all().map(item => [item.id, item.rowId, item.text])).toEqual([['A', 1, 'message A'], ['B', 2, 'message B']])
  })
  it('stops before a line the writer has not finished, so the next read takes it whole', () => {
    const path = join(temporary(), 'journal.jsonl')
    const journal = new FileJournal(path)
    journal.append(entry('A'))
    appendFileSync(path, '{"id":"B","rowId":2,"chat')
    expect(journal.all().map(item => item.id)).toEqual(['A'])
  })
  it('prunes old entries and keeps numbering after them', () => {
    const journal = new FileJournal(join(temporary(), 'journal.jsonl'))
    journal.append(entry('old', { at: new Date(T0 - 40 * 86_400_000).toISOString() }))
    journal.append(entry('new'))
    expect(journal.prune(T0 - 30 * 86_400_000)).toBe(1)
    expect(journal.append(entry('next')).rowId).toBe(3)
  })
})

describe('cloud commands', () => {
  it('pull starts after the newest entry, then answers what follows, a page at a time', () => {
    const journal = new MemoryJournal()
    journal.append(entry('A'))
    const first = cloudPull(journal, undefined, T0 + 5000)
    expect(first).toEqual({ items: [], next: formatCursor({ rowId: 1, at: T0 + 5000 }) })
    for (let index = 0; index < PULL_LIMIT + 2; index++) journal.append(entry(`M${index}`))
    const page = cloudPull(journal, first.next)
    expect(page.items).toHaveLength(PULL_LIMIT)
    expect(cloudPull(journal, page.next).items.map(item => item.id)).toEqual([`M${PULL_LIMIT}`, `M${PULL_LIMIT + 1}`])
    expect(parseCursor(cloudPull(journal, page.next).next).rowId).toBe(PULL_LIMIT + 3)
  })
  it('thread answers one chat\'s newest messages oldest first, with the time to page back from', () => {
    const journal = new MemoryJournal()
    for (let index = 1; index <= 4; index++) journal.append(entry(`D${index}`, { at: new Date(T0 + index * 1000).toISOString() }))
    journal.append(entry('G1', { chatId: GROUP, chatKind: 'group' }))
    const page = cloudThread(journal, DM, 2)
    expect(page.items.map(item => item.id)).toEqual(['D3', 'D4'])
    expect(cloudThread(journal, DM, 2, page.next)).toEqual({ items: expect.arrayContaining([expect.objectContaining({ id: 'D1' })]) })
    expect(() => cloudThread(journal, DM, 2, 'yesterday')).toThrow(BridgeError)
  })
  it('chats lists what the line has seen, newest first, with group names', () => {
    const journal = new MemoryJournal()
    journal.append(entry('G1', { chatId: GROUP, chatKind: 'group', chatName: 'Acme team' }))
    journal.append(entry('G2', { chatId: GROUP, chatKind: 'group' }))
    journal.append(entry('D1'))
    expect(cloudChats(journal)).toEqual([{ chatId: DM, name: null, kind: 'dm' }, { chatId: GROUP, name: 'Acme team', kind: 'group' }])
  })
  it('reply sends once per key, refuses a chat the line never saw, and after a crash trusts the journal', async () => {
    const journal = new MemoryJournal(); journal.append(entry('D1'))
    const sent: string[] = []
    const sender: CloudSender = { send: async (_chatId, text) => { sent.push(text); return { id: `out-${sent.length}` } } }
    const ledger = new MemoryLedger()
    expect(await cloudReply(journal, sender, ledger, DM, 'k1', 'PR #31 is ready')).toEqual({ status: 'sent' })
    expect(await cloudReply(journal, sender, ledger, DM, 'k1', 'PR #31 is ready')).toEqual({ status: 'sent', duplicate: true })
    await expect(cloudReply(journal, sender, ledger, 'any;-;+19995550000', 'k2', 'hi')).rejects.toMatchObject({ code: 410 })
    journal.append(entry('O1', { fromMe: true, sender: '', text: 'Merged', at: new Date(T0 + 1000).toISOString() }))
    ledger.set('k3', { state: 'pending', chatId: DM, at: T0 })
    expect(await cloudReply(journal, sender, ledger, DM, 'k3', 'Merged', T0)).toEqual({ status: 'sent', duplicate: true })
    expect(sent).toEqual(['PR #31 is ready'])
  })
})

describe('Spectrum messages', () => {
  const dm: SpectrumSpace = { id: DM, type: 'dm', send: async () => undefined }
  it('become journal entries: inbound from the sender\'s handle, outbound as the agent, Markdown as its text', () => {
    expect(fromSpectrum(dm, { id: 'm1', direction: 'inbound', timestamp: new Date(T0), sender: { id: '+15550102000' }, content: { type: 'text', text: 'fix #12' }, parentId: 'm0' }))
      .toEqual({ id: 'm1', chatId: DM, chatKind: 'dm', sender: '+15550102000', fromMe: false, bot: false, text: 'fix #12', at: new Date(T0).toISOString(), replyTo: 'm0' })
    expect(fromSpectrum({ ...dm, id: GROUP, type: 'group' }, { id: 'm2', direction: 'outbound', timestamp: new Date(T0), content: { type: 'markdown', markdown: '**done**' } }, 'Team'))
      .toMatchObject({ chatKind: 'group', chatName: 'Team', fromMe: true, sender: '', text: '**done**' })
  })
  it('are skipped when they carry no text the Source reads', () => {
    expect(fromSpectrum(dm, { id: 'r', timestamp: new Date(T0), content: { type: 'reaction' } })).toBeUndefined()
    expect(fromSpectrum(dm, { id: 't', timestamp: new Date(T0), content: { type: 'text', text: '  ' } })).toBeUndefined()
  })
})

describe('serve over loopback', () => {
  it('sends with the token, journals the agent\'s message, and refuses anything else', async () => {
    const journal = new MemoryJournal()
    const serveFake = await fakeServe(journal)
    const sender = httpSender({ port: serveFake.port, token: serveFake.token })
    expect(await sender.send(DM, 'On it')).toEqual({ id: 'out-1' })
    expect(journal.all()).toMatchObject([{ id: 'out-1', chatId: DM, fromMe: true, text: 'On it' }])
    await expect(httpSender({ port: serveFake.port, token: 'wrong' }).send(DM, 'x')).rejects.toMatchObject({ code: 401 })
    await expect(sender.send('any;-;broken', 'x')).rejects.toMatchObject({ code: 502, message: 'Spectrum refused the send' })
    await expect(httpSender({ port: 1, token: 't' }).send(DM, 'x')).rejects.toMatchObject({ code: 503 })
  })
  it('keeps its endpoint file private and says when serve is not running', () => {
    const path = join(temporary(), 'serve.json')
    writeEndpoint(path, { port: 8790, token: 't' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readEndpoint(path)).toEqual({ port: 8790, token: 't' })
    expect(() => readEndpoint(join(temporary(), 'none.json'))).toThrow(expect.objectContaining({ code: 503 }))
  })
})

describe('the CLI in cloud mode', () => {
  it('picks its mode from IMSG_BRIDGE_MODE', () => {
    expect(modeOf({})).toBe('local')
    expect(modeOf({ IMSG_BRIDGE_MODE: 'cloud' })).toBe('cloud')
    expect(() => modeOf({ IMSG_BRIDGE_MODE: 'mac' })).toThrow(BridgeError)
  })
  it('runs end to end: pull and chats read the journal, reply goes through serve, and serve needs its credentials', async () => {
    const home = temporary()
    const journal = new FileJournal(join(home, 'journal.jsonl'))
    journal.append(entry('D1', { text: 'fix issue #12' }))
    const serveFake = await fakeServe(journal)
    writeEndpoint(join(home, 'serve.json'), { port: serveFake.port, token: serveFake.token })
    const env = { ...process.env, IMSG_BRIDGE_MODE: 'cloud', IMSG_BRIDGE_HOME: home, PHOTON_PROJECT_ID: '', PHOTON_PROJECT_SECRET: '' }
    const cli = async (...args: string[]) => JSON.parse((await run(BIN, args, { env })).stdout) as Record<string, unknown>
    const start = await cli('pull', '--json')
    expect(start.items).toEqual([])
    expect(await cli('pull', '--json', '--after', formatCursor({ rowId: 0, at: T0 }))).toMatchObject({ items: [{ id: 'D1', text: 'fix issue #12' }] })
    expect(await cli('chats', '--json')).toEqual([{ chatId: DM, name: null, kind: 'dm' }])
    expect(await cli('reply', '--chat', DM, '--key', 'k1', '--text', 'PR #31 is ready')).toEqual({ status: 'sent' })
    expect(serveFake.sent).toEqual([{ chatId: DM, text: 'PR #31 is ready' }])
    expect(JSON.parse(readFileSync(join(home, 'ledger.json'), 'utf8'))).toMatchObject({ k1: { state: 'sent' } })
    const failed = await run(BIN, ['serve'], { env }).catch((error: { stderr: string }) => error)
    expect(JSON.parse((failed as { stderr: string }).stderr)).toMatchObject({ error: { code: 400, message: expect.stringContaining('PHOTON_PROJECT_ID') } })
    writeFileSync(join(home, 'serve.json'), 'garbage')
    const down = await run(BIN, ['reply', '--chat', DM, '--key', 'k2', '--text', 'x'], { env }).catch((error: { stderr: string }) => error)
    expect(JSON.parse((down as { stderr: string }).stderr)).toMatchObject({ error: { code: 503 } })
  }, 20_000)
})
