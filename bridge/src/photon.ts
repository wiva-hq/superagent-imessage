/**
 * The four bridge commands in photon mode, over Photon's v2 REST API (api.photon.codes) with a project API key: the same
 * JSON as local mode (`bridge.ts`), so the iMessage Source cannot tell the modes apart. Photon keeps the line's Messages,
 * Spaces (chats) and Users, so nothing runs beside the service and nothing is kept on disk: `pull` lists Messages after its
 * cursor, and a reply's key becomes the send's `idempotency-key`, which Photon replays instead of sending twice.
 */
import { createHash } from 'node:crypto'
import { BridgeError, LATE_MS, PULL_LIMIT, type BridgeMessage } from './bridge.ts'

/** One HTTP call to the project's API: `path` is under `/v1/projects/<project>`. */
export interface PhotonRequest {
  method: 'GET' | 'POST'; path: string; query?: Record<string, string | number | undefined>
  body?: unknown; headers?: Record<string, string>
}
export interface PhotonResponse { status: number; headers: Headers; body: any }
export type PhotonApi = (request: PhotonRequest) => Promise<PhotonResponse>

/** The API over `fetch`, authorized by a project API key (`pho_sk_…`). */
export function photonApi(projectId: string, apiKey: string, baseUrl = 'https://api.photon.codes'): PhotonApi {
  return async ({ method, path, query, body, headers }) => {
    const url = new URL(`/v1/projects/${encodeURIComponent(projectId)}${path}`, baseUrl)
    for (const [name, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(name, String(value))
    const response = await fetch(url, { method, signal: AbortSignal.timeout(15_000), headers: {
      authorization: `Bearer ${apiKey}`, accept: 'application/json', ...body === undefined ? {} : { 'content-type': 'application/json' }, ...headers,
    }, ...body === undefined ? {} : { body: JSON.stringify(body) } })
    const text = await response.text()
    let parsed: unknown = undefined
    try { parsed = text ? JSON.parse(text) : undefined } catch { parsed = text }
    return { status: response.status, headers: response.headers, body: parsed }
  }
}

/** Fails with the API's problem code, as a BridgeError the Source reads; a 5xx or 429 stays retryable as a 500. */
function check(response: PhotonResponse, what: string): any {
  if (response.status < 300) return response.body
  const code = typeof response.body?.code === 'string' ? response.body.code : `HTTP_${response.status}`
  const detail = response.body?.detail ?? response.body?.title ?? ''
  throw new BridgeError(`${what} failed: ${code}${detail ? ` (${detail})` : ''}`, response.status >= 500 || response.status === 429 ? 500 : response.status)
}

interface PhotonUser { id: string; handle: string; kind: string; details?: { resourceId?: string } }
interface PhotonSpace { id: string; kind: string; metadata?: { displayName?: string } }
interface PhotonMessage {
  id: string; status: string; createdAt: string; parentMessageId?: string
  content: { type: string; text?: string }; sentBy: PhotonUser; space: PhotonSpace; timestamps?: { receivedAt?: string }
}

export const kindOf = (space: Pick<PhotonSpace, 'kind'>): BridgeMessage['chatKind'] =>
  space.kind === 'direct' ? 'dm' : space.kind === 'group' ? 'group' : 'unknown'

/** Plain text in either direction: Photon also lists reads, typing, reactions and attachments as Messages. */
const readable = (message: PhotonMessage): boolean => message.content.type === 'text' && typeof message.content.text === 'string'

function toBridge(message: PhotonMessage): BridgeMessage {
  const fromMe = message.status !== 'received'
  const name = message.space.metadata?.displayName
  return {
    id: message.id, rowId: Date.parse(message.createdAt), chatId: message.space.id, chatKind: kindOf(message.space),
    ...name ? { chatName: name } : {}, sender: fromMe ? '' : message.sentBy.handle, fromMe, bot: false,
    text: message.content.text ?? '', at: message.timestamps?.receivedAt ?? message.createdAt,
    ...message.parentMessageId ? { replyTo: message.parentMessageId } : {},
  }
}

/**
 * The read position: the newest creation time taken, and the ids of the Messages taken since `LATE_MS` before it. Photon's
 * listing is eventually consistent, so each pull looks back that far and skips what it already answered.
 */
export interface PhotonCursor { at: number; seen: string[] }
const SEEN_MAX = 500
export const formatPhotonCursor = (cursor: PhotonCursor): string => `p1.${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`
export function parsePhotonCursor(value: string): PhotonCursor {
  try {
    if (!value.startsWith('p1.')) throw new Error('version')
    const cursor = JSON.parse(Buffer.from(value.slice(3), 'base64url').toString('utf8')) as PhotonCursor
    if (!Number.isFinite(cursor.at) || !Array.isArray(cursor.seen)) throw new Error('shape')
    return { at: cursor.at, seen: cursor.seen.filter(id => typeof id === 'string') }
  } catch { throw new BridgeError(`Unreadable cursor: ${value}`, 400) }
}

/**
 * Messages after the cursor, oldest first, and the cursor to continue from. Without a cursor it answers no messages and a
 * cursor at the present, so a new deployment starts there instead of replaying the line's history.
 */
export async function photonPull(api: PhotonApi, after: string | undefined, now = Date.now()): Promise<{ items: BridgeMessage[]; next: string }> {
  if (!after) return { items: [], next: formatPhotonCursor({ at: now, seen: [] }) }
  const cursor = parsePhotonCursor(after)
  const seen = new Set(cursor.seen)
  const taken: PhotonMessage[] = []
  let pageToken: string | undefined
  do {
    const page = check(await api({ method: 'GET', path: '/messages', query: {
      platform: 'imessage', createdSince: new Date(cursor.at - LATE_MS).toISOString(), orderBy: 'created_at', order: 'asc', pageSize: 200, pageToken,
    } }), 'Listing messages') as { items: PhotonMessage[]; nextPageToken?: string }
    for (const message of page.items) {
      if (seen.has(message.id)) continue
      seen.add(message.id)
      taken.push(message)
      if (taken.length >= PULL_LIMIT) break
    }
    pageToken = taken.length < PULL_LIMIT ? page.nextPageToken : undefined
  } while (pageToken)
  const at = Math.max(cursor.at, ...taken.map(message => Date.parse(message.createdAt)))
  // Keep only what the next look-back can still return, newest last, so the cursor stays small.
  const recent = [...cursor.seen.map(id => ({ id, at: cursor.at })), ...taken.map(message => ({ id: message.id, at: Date.parse(message.createdAt) }))]
    .filter(entry => entry.at >= at - LATE_MS).map(entry => entry.id).slice(-SEEN_MAX)
  return { items: taken.filter(readable).map(toBridge), next: formatPhotonCursor({ at, seen: recent }) }
}

/**
 * The line's agent User: the sender of replies, and what scopes a chat's listing, by its resource on a dedicated line or by
 * its own perspective on a shared one, which has no resource of the project's. `line` picks one of several.
 */
export async function agentOf(api: PhotonApi, line?: string): Promise<{ id: string; resourceId?: string }> {
  const page = check(await api({ method: 'GET', path: '/users', query: { platform: 'imessage', pageSize: 100 } }), 'Listing users') as { items: PhotonUser[] }
  const digits = (handle: string) => handle.replace(/[^\d+@a-z.]/gi, '').toLowerCase()
  const agents = page.items.filter(user => user.kind === 'agent' && (!line || digits(user.handle) === digits(line)))
  if (agents.length !== 1) {
    throw new BridgeError(agents.length ? `Several iMessage lines in this project: set PHOTON_IMESSAGE_LINE to one of ${agents.map(user => user.handle).join(', ')}`
      : `No iMessage line${line ? ` ${line}` : ''} in this project`, 400)
  }
  const resourceId = agents[0]!.details?.resourceId
  return { id: agents[0]!.id, ...resourceId ? { resourceId } : {} }
}

/** The send's idempotency key for a reply key: Photon takes 1 to 255 printable ASCII characters. */
export function idempotencyKey(key: string): string {
  const plain = `imsg-bridge:${key}`
  return /^[\x21-\x7e]{1,255}$/.test(plain) ? plain : `imsg-bridge:${createHash('sha256').update(key).digest('hex')}`
}
/** Problems that mean this chat can never take the reply, so the Outbox stops retrying it. */
const GONE = new Set(['SPACE_NOT_FOUND', 'SPACE_NOT_SENDABLE', 'SHARED_LINE_INBOUND_REQUIRED', 'SHARED_LINE_NOT_ASSIGNED', 'SHARED_LINE_GROUP_UNSUPPORTED'])

/**
 * Sends `text` into `chatId` once per `key`: Photon answers a repeated `idempotency-key` with the Message it already took
 * (`Idempotent-Replayed: true`), so a retry after a crash neither loses the reply nor posts it twice.
 */
export async function photonReply(api: PhotonApi, chatId: string, key: string, text: string, line?: string): Promise<{ status: 'sent'; duplicate?: true }> {
  if (!text.trim()) throw new BridgeError('Empty reply text', 400)
  const agent = await agentOf(api, line)
  const response = await api({ method: 'POST', path: '/messages', headers: { 'idempotency-key': idempotencyKey(key) },
    body: { spaceId: chatId, senderId: agent.id, content: { type: 'text', format: 'plain', text } } })
  if (response.status >= 400 && GONE.has(response.body?.code)) throw new BridgeError(`Chat cannot take a reply: ${response.body.code}`, 410)
  check(response, 'Sending')
  return response.headers.get('idempotent-replayed') === 'true' ? { status: 'sent', duplicate: true } : { status: 'sent' }
}

/**
 * A page of one chat, oldest first: the `limit` newest messages before `before` (an ISO time; the present when omitted), and
 * `next`, the time to read the older page from, while older messages may remain.
 */
export async function photonThread(api: PhotonApi, chatId: string, limit: number, before?: string, line?: string): Promise<{ items: BridgeMessage[]; next?: string }> {
  const until = before ? Date.parse(before) : undefined
  if (until !== undefined && !Number.isFinite(until)) throw new BridgeError(`Unreadable time: ${before}`, 400)
  const agent = await agentOf(api, line)
  const read = (pageToken?: string) => api({ method: 'GET', path: '/messages', query: agent.resourceId
    ? { spaceId: chatId, resourceId: agent.resourceId, order: 'desc', pageSize: limit, createdBefore: until === undefined ? undefined : new Date(until).toISOString() }
    // A shared line's chat is read from the agent's perspective, which takes no time bounds, so `before` is applied here.
    : { spaceId: chatId, perspectiveUserId: agent.id, order: 'desc', pageSize: 200, pageToken } }).then(response => check(response, 'Reading the chat') as { items: PhotonMessage[]; nextPageToken?: string })
  let rows: PhotonMessage[]
  let more: boolean
  if (agent.resourceId) {
    const page = await read()
    rows = page.items
    more = Boolean(page.nextPageToken)
  } else {
    rows = []
    let pageToken: string | undefined
    for (let pages = 0; pages < THREAD_PAGES_MAX && rows.length <= limit; pages++) {
      const page = await read(pageToken)
      rows.push(...page.items.filter(message => until === undefined || Date.parse(message.createdAt) < until))
      pageToken = page.nextPageToken
      if (!pageToken) break
    }
    more = rows.length > limit || Boolean(pageToken)
    rows = rows.slice(0, limit)
  }
  rows = [...rows].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  const oldest = rows[0]
  return { items: rows.filter(readable).map(toBridge), ...more && oldest ? { next: oldest.createdAt } : {} }
}
/** How many pages a shared line's chat is read back through to find the messages before a time. */
const THREAD_PAGES_MAX = 5

/** The line's chats, most recent first, for the Source's chat picker. */
export async function photonChats(api: PhotonApi): Promise<{ chatId: string; name: string | null; kind: string }[]> {
  const page = check(await api({ method: 'GET', path: '/spaces', query: { platform: 'imessage', orderBy: 'last_message_created_at', order: 'desc', pageSize: 100 } }),
    'Listing chats') as { items: PhotonSpace[] }
  return page.items.map(space => ({ chatId: space.id, name: space.metadata?.displayName ?? null, kind: kindOf(space) }))
}
