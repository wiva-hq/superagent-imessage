import { execFile } from 'node:child_process'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { BridgeError, LATE_MS, PULL_LIMIT } from '../src/bridge.ts'
import { modeOf } from '../src/cli.ts'
import {
  agentOf, formatPhotonCursor, idempotencyKey, parsePhotonCursor, photonApi, photonChats, photonPull, photonReply, photonThread,
  type PhotonApi, type PhotonRequest,
} from '../src/photon.ts'

const run = promisify(execFile)
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'imsg-bridge')
const T0 = Date.parse('2026-11-01T07:00:00.000Z')
const DM = 'pho_spc_0000000000000000000000000a'
const GROUP = 'pho_spc_0000000000000000000000000b'
const AGENT = { id: 'pho_usr_0000000000000000000000000a', handle: '+16285550100', kind: 'agent', details: { resourceId: 'pho_res_0000000000000000000000000a', type: 'dedicated' } }
const SHARED_AGENT = { id: 'pho_usr_0000000000000000000000000d', handle: '+16285550100', kind: 'agent', details: { type: 'shared' } }
const PERSON = { id: 'pho_usr_0000000000000000000000000b', handle: '+15550102000', kind: 'user', details: {} }
const spaces = { [DM]: { id: DM, kind: 'direct', metadata: {} }, [GROUP]: { id: GROUP, kind: 'group', metadata: { displayName: 'Acme team' } } }

function message(id: string, at: number, overrides: Record<string, unknown> = {}) {
  return { id, status: 'received', createdAt: new Date(at).toISOString(), content: { type: 'text', format: 'plain', text: `message ${id}` },
    sentBy: PERSON, space: spaces[DM], timestamps: { receivedAt: new Date(at).toISOString() }, ...overrides }
}
type Row = ReturnType<typeof message>

/** Photon's project API over an in-memory store: message listing, users, spaces and idempotent sends. */
function fakePhoton(rows: Row[] = [], users: unknown[] = [AGENT, PERSON]) {
  const requests: PhotonRequest[] = []
  const sends = new Map<string, unknown>()
  const api: PhotonApi = async request => {
    requests.push(request)
    const { method, path, query = {} } = request
    const ok = (body: unknown, headers: Record<string, string> = {}) => ({ status: 200, headers: new Headers(headers), body })
    const problem = (status: number, code: string) => ({ status, headers: new Headers(), body: { code, status, title: code } })
    if (method === 'GET' && path === '/users') return ok({ items: users })
    if (method === 'GET' && path === '/spaces') return ok({ items: Object.values(spaces) })
    if (method === 'GET' && path === '/messages') {
      // As the API does: a User perspective takes no time bounds.
      if (query.perspectiveUserId && (query.createdBefore || query.createdSince)) return problem(422, 'VALIDATION_FAILED')
      let list = rows.filter(row => (!query.spaceId || row.space.id === query.spaceId)
        && (!query.createdSince || Date.parse(row.createdAt) >= Date.parse(String(query.createdSince)))
        && (!query.createdBefore || Date.parse(row.createdAt) < Date.parse(String(query.createdBefore))))
      list = list.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
      if (query.order === 'desc') list.reverse()
      const start = query.pageToken ? Number(String(query.pageToken).split('.')[1]) : 0, size = Number(query.pageSize ?? 50)
      const end = start + size
      return ok({ items: list.slice(start, end), ...end < list.length ? { nextPageToken: `p.${end}` } : {} })
    }
    if (method === 'POST' && path === '/messages') {
      const body = request.body as { spaceId: string; content: { text: string } }
      if (body.spaceId === 'pho_spc_gone') return problem(404, 'SPACE_NOT_FOUND')
      if (body.spaceId === 'pho_spc_shared') return problem(403, 'SHARED_LINE_INBOUND_REQUIRED')
      if (body.spaceId === 'pho_spc_down') return problem(503, 'UPSTREAM_UNAVAILABLE')
      const key = request.headers!['idempotency-key']!
      if (sends.has(key)) return { status: 202, headers: new Headers({ 'idempotent-replayed': 'true' }), body: sends.get(key) }
      sends.set(key, body)
      return { status: 202, headers: new Headers({ 'idempotent-replayed': 'false' }), body }
    }
    return problem(404, 'NOT_FOUND')
  }
  return { api, requests, sends }
}

describe('photon mode: pull', () => {
  it('starts at the present without replaying the history', async () => {
    const { api, requests } = fakePhoton([message('pho_msg_old', T0 - 60_000)])
    const page = await photonPull(api, undefined, T0)
    expect(page.items).toEqual([])
    expect(parsePhotonCursor(page.next)).toEqual({ at: T0, seen: [] })
    expect(requests).toEqual([])
  })

  it('answers the messages after the cursor, oldest first, in the Source shape', async () => {
    const group = message('pho_msg_g', T0 + 2000, { space: spaces[GROUP], parentMessageId: 'pho_msg_a' })
    const { api, requests } = fakePhoton([message('pho_msg_old', T0 - LATE_MS - 1), message('pho_msg_a', T0 + 1000), group])
    const page = await photonPull(api, formatPhotonCursor({ at: T0, seen: [] }))
    expect(page.items).toEqual([
      { id: 'pho_msg_a', rowId: T0 + 1000, chatId: DM, chatKind: 'dm', sender: '+15550102000', fromMe: false, bot: false,
        text: 'message pho_msg_a', at: new Date(T0 + 1000).toISOString() },
      { id: 'pho_msg_g', rowId: T0 + 2000, chatId: GROUP, chatKind: 'group', chatName: 'Acme team', sender: '+15550102000', fromMe: false,
        bot: false, text: 'message pho_msg_g', at: new Date(T0 + 2000).toISOString(), replyTo: 'pho_msg_a' },
    ])
    expect(requests[0]!.query).toMatchObject({ platform: 'imessage', order: 'asc', orderBy: 'created_at', createdSince: new Date(T0 - LATE_MS).toISOString() })
    expect(parsePhotonCursor(page.next)).toEqual({ at: T0 + 2000, seen: ['pho_msg_a', 'pho_msg_g'] })
    expect((await photonPull(api, page.next)).items).toEqual([])
  })

  it('takes a message that shows up late in the listing, once', async () => {
    const rows = [message('pho_msg_a', T0 + 1000)]
    const { api } = fakePhoton(rows)
    const first = await photonPull(api, formatPhotonCursor({ at: T0, seen: [] }))
    rows.push(message('pho_msg_late', T0 + 500))
    const second = await photonPull(api, first.next)
    expect(second.items.map(item => item.id)).toEqual(['pho_msg_late'])
    expect((await photonPull(api, second.next)).items).toEqual([])
  })

  it('moves past reads, typing and attachments, and marks the agent’s own messages', async () => {
    const rows = [
      message('pho_msg_read', T0 + 1, { content: { type: 'message.read' } }),
      message('pho_msg_image', T0 + 2, { content: { type: 'attachment' } }),
      message('pho_msg_mine', T0 + 3, { status: 'delivered', sentBy: AGENT }),
    ]
    const page = await photonPull(fakePhoton(rows).api, formatPhotonCursor({ at: T0, seen: [] }))
    expect(page.items.map(item => [item.id, item.sender, item.fromMe])).toEqual([['pho_msg_mine', '', true]])
    expect(parsePhotonCursor(page.next).seen).toEqual(['pho_msg_read', 'pho_msg_image', 'pho_msg_mine'])
  })

  it('stops a page at the limit and continues after it', async () => {
    const rows = Array.from({ length: PULL_LIMIT + 5 }, (_, index) => message(`pho_msg_${String(index).padStart(4, '0')}`, T0 + index + 1))
    const { api } = fakePhoton(rows)
    const first = await photonPull(api, formatPhotonCursor({ at: T0, seen: [] }))
    expect(first.items).toHaveLength(PULL_LIMIT)
    const second = await photonPull(api, first.next)
    expect(second.items.map(item => item.id)).toEqual(['pho_msg_0200', 'pho_msg_0201', 'pho_msg_0202', 'pho_msg_0203', 'pho_msg_0204'])
  })

  it('refuses an unreadable cursor, and fails on an API error', async () => {
    await expect(photonPull(fakePhoton().api, '12@2026-11-01T07:00:00.000Z')).rejects.toThrow(BridgeError)
    const failing: PhotonApi = async () => ({ status: 401, headers: new Headers(), body: { code: 'NOT_AUTHENTICATED', title: 'Not Authenticated' } })
    await expect(photonPull(failing, formatPhotonCursor({ at: T0, seen: [] }))).rejects.toMatchObject({ code: 401, message: expect.stringContaining('NOT_AUTHENTICATED') })
  })
})

describe('photon mode: reply', () => {
  it('sends once per key, as the line’s agent, with a key Photon replays', async () => {
    const { api, requests } = fakePhoton()
    expect(await photonReply(api, DM, 'outbox-1', 'On it')).toEqual({ status: 'sent' })
    expect(await photonReply(api, DM, 'outbox-1', 'On it')).toEqual({ status: 'sent', duplicate: true })
    const send = requests.find(request => request.method === 'POST')!
    expect(send.headers).toEqual({ 'idempotency-key': 'imsg-bridge:outbox-1' })
    expect(send.body).toEqual({ spaceId: DM, senderId: AGENT.id, content: { type: 'text', format: 'plain', text: 'On it' } })
  })

  it('answers 410 when the chat can never take the reply, and keeps upstream failures retryable', async () => {
    const { api } = fakePhoton()
    await expect(photonReply(api, 'pho_spc_gone', 'k', 'hi')).rejects.toMatchObject({ code: 410 })
    await expect(photonReply(api, 'pho_spc_shared', 'k', 'hi')).rejects.toMatchObject({ code: 410 })
    await expect(photonReply(api, 'pho_spc_down', 'k', 'hi')).rejects.toMatchObject({ code: 500 })
    await expect(photonReply(api, DM, 'k', ' ')).rejects.toMatchObject({ code: 400 })
  })

  it('makes any key a valid idempotency key', () => {
    expect(idempotencyKey('deploy-12-1')).toBe('imsg-bridge:deploy-12-1')
    expect(idempotencyKey('with space')).toMatch(/^imsg-bridge:[0-9a-f]{64}$/)
    expect(idempotencyKey('x'.repeat(300))).toMatch(/^imsg-bridge:[0-9a-f]{64}$/)
  })

  it('finds the line’s agent, and asks which one when there are several', async () => {
    const other = { ...AGENT, id: 'pho_usr_0000000000000000000000000c', handle: '+16285550199', details: { resourceId: 'pho_res_0000000000000000000000000c' } }
    expect(await agentOf(fakePhoton().api)).toEqual({ id: AGENT.id, resourceId: AGENT.details.resourceId })
    const two = fakePhoton([], [AGENT, other, PERSON]).api
    await expect(agentOf(two)).rejects.toThrow(/PHOTON_IMESSAGE_LINE/)
    expect((await agentOf(two, '+1 (628) 555-0199')).id).toBe(other.id)
    await expect(agentOf(fakePhoton([], [PERSON]).api)).rejects.toThrow(/No iMessage line/)
  })

  it('sends from a shared line’s agent, which has no resource of the project’s', async () => {
    const { api, requests } = fakePhoton([], [SHARED_AGENT, PERSON])
    expect(await agentOf(api)).toEqual({ id: SHARED_AGENT.id })
    await photonReply(api, DM, 'outbox-2', 'Done')
    expect(requests.at(-1)!.body).toMatchObject({ senderId: SHARED_AGENT.id })
  })
})

describe('photon mode: thread and chats', () => {
  const rows = [
    message('pho_msg_a', T0), message('pho_msg_b', T0 + 1000),
    message('pho_msg_tap', T0 + 1500, { content: { type: 'reaction' } }), message('pho_msg_c', T0 + 2000),
    message('pho_msg_g', T0 + 3000, { space: spaces[GROUP] }),
  ]

  it('reads a chat oldest first, scoped to the line, and names the older page', async () => {
    const { api, requests } = fakePhoton(rows)
    const newest = await photonThread(api, DM, 2)
    expect(newest.items.map(item => item.id)).toEqual(['pho_msg_c'])
    expect(newest.next).toBe(new Date(T0 + 1500).toISOString())
    expect(requests.at(-1)!.query).toMatchObject({ spaceId: DM, resourceId: AGENT.details.resourceId, order: 'desc', pageSize: 2 })
    const older = await photonThread(api, DM, 2, newest.next)
    expect(older.items.map(item => item.id)).toEqual(['pho_msg_a', 'pho_msg_b'])
    expect(older.next).toBeUndefined()
    await expect(photonThread(api, DM, 2, 'yesterday')).rejects.toThrow(BridgeError)
  })

  it('reads a shared line’s chat from the agent’s perspective, applying the time bound itself', async () => {
    const { api, requests } = fakePhoton(rows, [SHARED_AGENT, PERSON])
    const newest = await photonThread(api, DM, 2)
    expect(newest.items.map(item => item.id)).toEqual(['pho_msg_c'])
    expect(newest.next).toBe(new Date(T0 + 1500).toISOString())
    expect(requests.at(-1)!.query).toMatchObject({ spaceId: DM, perspectiveUserId: SHARED_AGENT.id, order: 'desc' })
    expect(requests.at(-1)!.query).not.toHaveProperty('createdBefore')
    const older = await photonThread(api, DM, 2, newest.next)
    expect(older.items.map(item => item.id)).toEqual(['pho_msg_a', 'pho_msg_b'])
    expect(older.next).toBeUndefined()
  })

  it('lists the line’s chats with their kind and name', async () => {
    expect(await photonChats(fakePhoton().api)).toEqual([{ chatId: DM, name: null, kind: 'dm' }, { chatId: GROUP, name: 'Acme team', kind: 'group' }])
  })
})

describe('photon mode: the HTTP client and the CLI', () => {
  it('calls the project’s API with the key, the query and the body', async () => {
    let seen: { method?: string; url?: string; auth?: string; key?: string; body?: string } = {}
    const server = createServer((request: IncomingMessage, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        seen = { method: request.method, url: request.url, auth: request.headers.authorization, key: request.headers['idempotency-key'] as string, body }
        response.writeHead(202, { 'content-type': 'application/json', 'idempotent-replayed': 'false' }).end('{"id":"pho_msg_x"}')
      })
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const api = photonApi('pho_prj_0000000000000000000000000a', 'pho_sk_test', `http://127.0.0.1:${(server.address() as AddressInfo).port}`)
      const response = await api({ method: 'POST', path: '/messages', query: { a: 1, b: undefined }, headers: { 'idempotency-key': 'k' }, body: { x: 1 } })
      expect(response).toMatchObject({ status: 202, body: { id: 'pho_msg_x' } })
      expect(response.headers.get('idempotent-replayed')).toBe('false')
      expect(seen).toEqual({ method: 'POST', url: '/v1/projects/pho_prj_0000000000000000000000000a/messages?a=1', auth: 'Bearer pho_sk_test', key: 'k', body: '{"x":1}' })
    } finally { await new Promise(resolve => { server.close(resolve) }) }
  })

  it('is a mode of its own that needs the project and its key', async () => {
    expect(modeOf({ IMSG_BRIDGE_MODE: 'photon' })).toBe('photon')
    const env = { ...process.env, IMSG_BRIDGE_MODE: 'photon', PHOTON_PROJECT_ID: '', PHOTON_API_KEY: '' }
    const missing = await run(BIN, ['chats', '--json'], { env }).catch((error: { stderr: string }) => error)
    expect(JSON.parse(missing.stderr)).toEqual({ error: { code: 400, message: expect.stringContaining('PHOTON_API_KEY') } })
  })
})
