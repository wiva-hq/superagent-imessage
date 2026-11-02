/**
 * `imsg-bridge serve`: the cloud mode's long-running half. It holds one Photon Spectrum connection, writes every iMessage it
 * sees to the journal, and sends replies that `imsg-bridge reply` hands it over loopback HTTP. The Source never talks to it
 * directly; it keeps calling the short commands, which read the journal and post here.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BridgeError, type BridgeMessage } from './bridge.ts'
import type { CloudSender } from './cloud.ts'
import { FileJournal, type Journal } from './journal.ts'

/** The parts of a Spectrum space and message the bridge reads; structural so tests need no Spectrum connection. */
export interface SpectrumSpace { id: string; type?: string; getDisplayName?(): Promise<string | undefined>; send(content: string): Promise<{ id: string } | undefined> }
export interface SpectrumMessage {
  id: string; direction?: 'inbound' | 'outbound'; timestamp: Date; sender?: { id: string } | undefined
  content: { type: string; text?: string; markdown?: string }; isSystemMessage?: boolean; parentId?: string
}
/** Spectrum is "dm" or "group"; anything else is passed on as unknown, which the Source treats as a group. */
const kindOf = (space: SpectrumSpace): BridgeMessage['chatKind'] => space.type === 'dm' ? 'dm' : space.type === 'group' ? 'group' : 'unknown'

/**
 * A Spectrum message as a journal entry, or undefined for what the Source does not read: Tapbacks, typing, edits, polls,
 * attachments without text. A Markdown body is kept as its text.
 */
export function fromSpectrum(space: SpectrumSpace, message: SpectrumMessage, chatName?: string): Omit<BridgeMessage, 'rowId'> | undefined {
  const text = message.content.type === 'text' ? message.content.text : message.content.type === 'markdown' ? message.content.markdown : undefined
  if (text === undefined || !text.trim()) return undefined
  const fromMe = message.direction === 'outbound'
  return {
    id: message.id, chatId: space.id, chatKind: kindOf(space), ...chatName ? { chatName } : {},
    sender: fromMe ? '' : message.sender?.id ?? '', fromMe, bot: message.isSystemMessage === true, text,
    at: message.timestamp.toISOString(), ...message.parentId ? { replyTo: message.parentId } : {},
  }
}

/** Where `serve` listens and the token that `reply` must present: written by `serve`, read by `reply`. */
export interface Endpoint { port: number; token: string }
export function writeEndpoint(path: string, endpoint: Endpoint): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(endpoint), { mode: 0o600 })
  chmodSync(path, 0o600)
}
export function readEndpoint(path: string): Endpoint {
  try { return JSON.parse(readFileSync(path, 'utf8')) as Endpoint }
  catch { throw new BridgeError('imsg-bridge serve is not running (no endpoint file); start it first', 503) }
}

/** The sender `reply` uses: a POST to `serve` on 127.0.0.1. */
export function httpSender(endpoint: Endpoint, fetcher: typeof fetch = fetch): CloudSender {
  return {
    async send(chatId, text) {
      let response: Response
      try {
        response = await fetcher(`http://127.0.0.1:${endpoint.port}/send`, { method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.token}` }, body: JSON.stringify({ chatId, text }) })
      } catch (error) { throw new BridgeError(`imsg-bridge serve did not answer: ${String(error)}`, 503) }
      const body = await response.json().catch(() => ({})) as { id?: string; error?: { code?: number; message?: string } }
      if (!response.ok || !body.id) throw new BridgeError(body.error?.message ?? `serve answered ${response.status}`, body.error?.code ?? response.status)
      return { id: body.id }
    },
  }
}

/** How `serve` reaches a chat: the space it last saw a message in, else Spectrum's lookup by id. */
export type SpaceLookup = (chatId: string) => Promise<SpectrumSpace>

/** The loopback HTTP handler of `serve`: `POST /send` with the token sends one text and journals it as the agent's. */
export function sendHandler(token: string, lookup: SpaceLookup, journal: Journal) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const answer = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)) }
    if (request.method !== 'POST' || request.url !== '/send') return answer(404, { error: { code: 404, message: 'Not found' } })
    if (request.headers.authorization !== `Bearer ${token}`) return answer(401, { error: { code: 401, message: 'Bad token' } })
    let input: { chatId?: unknown; text?: unknown }
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof input
    } catch { return answer(400, { error: { code: 400, message: 'Body is not JSON' } }) }
    if (typeof input.chatId !== 'string' || typeof input.text !== 'string' || !input.text.trim()) {
      return answer(400, { error: { code: 400, message: 'Need chatId and text' } })
    }
    try {
      const space = await lookup(input.chatId)
      const sent = await space.send(input.text)
      const id = sent?.id ?? `sent-${Date.now()}-${randomBytes(4).toString('hex')}`
      journal.append({ id, chatId: space.id, chatKind: kindOf(space), sender: '', fromMe: true, bot: false, text: input.text, at: new Date().toISOString() })
      answer(200, { id })
    } catch (error) {
      answer(error instanceof BridgeError ? error.code : 502, { error: { code: error instanceof BridgeError ? error.code : 502, message: error instanceof Error ? error.message : String(error) } })
    }
  }
}

export interface ServeOptions { journalPath: string; endpointPath: string; port: number; projectId: string; projectSecret: string; keepDays: number }

/**
 * Connects to Spectrum Cloud and runs until stopped: journals each message, serves sends, and reconnects with a backoff
 * (1 s doubling to 60 s) when the stream ends or fails. Telemetry is off: message text stays between the line and this host.
 */
export async function serve(options: ServeOptions, signal: AbortSignal, log: (line: string) => void = line => { process.stderr.write(`${line}\n`) }): Promise<void> {
  const [{ Spectrum }, { imessage }] = await Promise.all([import('@spectrum-ts/core'), import('@spectrum-ts/imessage')])
  const journal = new FileJournal(options.journalPath)
  const pruned = journal.prune(Date.now() - options.keepDays * 86_400_000)
  if (pruned) log(`pruned ${pruned} journal entries older than ${options.keepDays} days`)
  const spaces = new Map<string, SpectrumSpace>()
  const names = new Map<string, string>()
  let app: Awaited<ReturnType<typeof Spectrum>> | undefined
  const lookup: SpaceLookup = async chatId => {
    const known = spaces.get(chatId)
    if (known) return known
    if (!app) throw new BridgeError('Not connected to Spectrum yet', 503)
    return await imessage(app).space.get(chatId) as unknown as SpectrumSpace
  }
  const token = randomBytes(24).toString('hex')
  const server: Server = createServer((request, response) => { void sendHandler(token, lookup, journal)(request, response) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', resolve) })
  writeEndpoint(options.endpointPath, { port: options.port, token })
  log(`listening on 127.0.0.1:${options.port}`)
  let backoff = 1000
  try {
    while (!signal.aborted) {
      try {
        app = await Spectrum({ projectId: options.projectId, projectSecret: options.projectSecret, providers: [imessage.config()],
          options: { flattenGroups: true }, telemetry: false, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) })
        log('connected to Spectrum')
        backoff = 1000
        const stop = () => { void app?.stop() }
        signal.addEventListener('abort', stop, { once: true })
        try {
          for await (const [space, message] of app.messages) {
            if (!imessage.is(message)) continue
            const chat = space as unknown as SpectrumSpace
            spaces.set(chat.id, chat)
            if (chat.type === 'group' && !names.has(chat.id) && chat.getDisplayName) {
              names.set(chat.id, await chat.getDisplayName().catch(() => undefined) ?? '')
            }
            const entry = fromSpectrum(chat, message as unknown as SpectrumMessage, names.get(chat.id) || undefined)
            if (entry) journal.append(entry)
          }
        } finally { signal.removeEventListener('abort', stop) }
      } catch (error) {
        if (signal.aborted) break
        log(`Spectrum stream failed: ${error instanceof Error ? error.message : String(error)}; reconnecting in ${backoff / 1000} s`)
      }
      if (signal.aborted) break
      await delay(backoff, undefined, { signal }).catch(() => {})
      backoff = Math.min(backoff * 2, 60_000)
    }
  } finally {
    await app?.stop().catch(() => {})
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  }
}
