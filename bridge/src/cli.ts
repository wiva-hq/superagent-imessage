/**
 * `imsg-bridge`: the iMessage Source's CLI. Four modes, chosen by `IMSG_BRIDGE_MODE`:
 *
 * - `local` (default): reads chat.db and sends through Messages.app with Photon's imessage-kit. Needs macOS, the agent's
 *   Apple ID signed in to Messages, and Full Disk Access for the process that runs it.
 * - `cloud`: Photon Spectrum Cloud holds the iMessage line, so any host works, Linux included. `imsg-bridge serve` runs
 *   alongside the service with `PHOTON_PROJECT_ID` and `PHOTON_PROJECT_SECRET`; the other commands read its journal.
 * - `advanced`: Photon's Advanced iMessage server holds the line and its history, so any host works and nothing runs beside
 *   the service. Each command calls the server over gRPC at `PHOTON_IMESSAGE_ADDRESS` with `PHOTON_IMESSAGE_TOKEN`.
 * - `photon`: Photon's v2 API (api.photon.codes) holds the line, its chats and messages, so any host works and nothing runs
 *   beside the service. Each command calls it with `PHOTON_PROJECT_ID` (`pho_prj_…`) and `PHOTON_API_KEY` (`pho_sk_…`);
 *   `PHOTON_IMESSAGE_LINE` picks the line when the project has several.
 *
 *   imsg-bridge pull [--after <cursor>] --json
 *   imsg-bridge reply --chat <chatId> --key <key> --text <text>
 *   imsg-bridge thread --chat <chatId> [--limit <n>] [--before <iso time>] --json
 *   imsg-bridge chats --json
 *   imsg-bridge serve                       (cloud mode only; runs until stopped)
 *
 * Credentials can live in `$IMSG_BRIDGE_HOME/bridge.env` (default `~/.imsg-bridge/bridge.env`), readable only by its user:
 * DeepSeek Harness strips variables named like KEY, SECRET, TOKEN or PASSWORD from the commands it runs, so a key set in the
 * service's environment would never reach the bridge. A variable set in the environment wins over the file.
 *
 * Output is JSON on stdout. A failure prints `{"error":{"code","message"}}` on stderr and exits 1.
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { advancedChats, advancedPull, advancedReply, advancedThread, type AdvancedPort } from './advanced.ts'
import { BridgeError, chats, pull, reply, thread, type MessagesPort } from './bridge.ts'
import { photonApi, photonChats, photonPull, photonReply, photonThread } from './photon.ts'
import { cloudChats, cloudPull, cloudReply, cloudThread } from './cloud.ts'
import { FileJournal } from './journal.ts'
import { FileLedger } from './ledger.ts'
import { httpSender, readEndpoint, serve } from './serve.ts'

const homeOf = (env: NodeJS.ProcessEnv): string => env.IMSG_BRIDGE_HOME || join(homedir(), '.imsg-bridge')

/**
 * The environment with the variables of `bridge.env` added where the environment has none. The file holds `NAME=value` lines,
 * `#` comments and blank lines; it must be readable by its user only, as it holds the line's credentials.
 */
export function withBridgeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const path = join(homeOf(env), 'bridge.env')
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return env }
  if (statSync(path).mode & 0o077) throw new BridgeError(`${path} holds credentials and must be readable by its user only: chmod 600 ${path}`, 400)
  const merged = { ...env }
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match || line.trimStart().startsWith('#')) continue
    const value = match[2]!.replace(/^(["'])(.*)\1$/, '$2')
    if (!merged[match[1]!]) merged[match[1]!] = value
  }
  return merged
}
const COMMANDS = ['pull', 'reply', 'thread', 'chats', 'serve']

export type Mode = 'local' | 'cloud' | 'advanced' | 'photon'
export function modeOf(env: NodeJS.ProcessEnv = process.env): Mode {
  const mode = env.IMSG_BRIDGE_MODE || 'local'
  if (mode !== 'local' && mode !== 'cloud' && mode !== 'advanced' && mode !== 'photon') {
    throw new BridgeError(`IMSG_BRIDGE_MODE must be local, cloud, advanced or photon, not ${mode}`, 400)
  }
  return mode
}

async function port(): Promise<MessagesPort & { close(): Promise<void> }> {
  const { IMessageSDK } = await import('@photon-ai/imessage-kit')
  return new IMessageSDK()
}
/** The Advanced iMessage client; `PHOTON_IMESSAGE_TLS=false` is for a server on the same machine during development. */
async function advancedPort(env: NodeJS.ProcessEnv): Promise<AdvancedPort & { close(): Promise<void> }> {
  const address = env.PHOTON_IMESSAGE_ADDRESS, token = env.PHOTON_IMESSAGE_TOKEN
  if (!address || !token) throw new BridgeError('Set PHOTON_IMESSAGE_ADDRESS and PHOTON_IMESSAGE_TOKEN (the Advanced iMessage server)', 400)
  const { createClient } = await import('@photon-ai/advanced-imessage/grpc')
  return createClient({ address, token, tls: env.PHOTON_IMESSAGE_TLS !== 'false', timeout: 15_000, retry: true })
}
function option(values: Record<string, string | boolean | undefined>, name: string): string {
  const value = values[name]
  if (typeof value !== 'string' || !value) throw new BridgeError(`Missing --${name}`, 400)
  return value
}
function limitOf(values: Record<string, string | boolean | undefined>): number {
  const limit = Number(values.limit ?? 20)
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new BridgeError('--limit must be 1 to 200', 400)
  return limit
}

export async function main(argv: string[], processEnv: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const env = withBridgeEnv(processEnv)
  const HOME = homeOf(env)
  const [command, ...rest] = argv
  const { values } = parseArgs({ args: rest, strict: true, options: {
    after: { type: 'string' }, chat: { type: 'string' }, key: { type: 'string' }, text: { type: 'string' },
    limit: { type: 'string' }, before: { type: 'string' }, json: { type: 'boolean' },
  } })
  if (!command || !COMMANDS.includes(command)) throw new BridgeError(`Unknown command: ${command ?? ''}. Use ${COMMANDS.join(', ')}.`, 400)
  const mode = modeOf(env)
  const ledger = () => new FileLedger(join(HOME, 'ledger.json'))
  if (mode === 'cloud') {
    const journal = new FileJournal(join(HOME, 'journal.jsonl'))
    switch (command) {
      case 'serve': {
        const projectId = env.PHOTON_PROJECT_ID, projectSecret = env.PHOTON_PROJECT_SECRET
        if (!projectId || !projectSecret) throw new BridgeError('Set PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET (app.photon.codes)', 400)
        const controller = new AbortController()
        for (const name of ['SIGINT', 'SIGTERM'] as const) process.once(name, () => { controller.abort() })
        await serve({ journalPath: join(HOME, 'journal.jsonl'), endpointPath: join(HOME, 'serve.json'), port: Number(env.IMSG_BRIDGE_PORT || 8790),
          projectId, projectSecret, keepDays: Number(env.IMSG_BRIDGE_KEEP_DAYS || 30) }, controller.signal)
        return { status: 'stopped' }
      }
      case 'pull': return cloudPull(journal, values.after)
      case 'reply': return await cloudReply(journal, httpSender(readEndpoint(join(HOME, 'serve.json'))), ledger(),
        option(values, 'chat'), option(values, 'key'), option(values, 'text'))
      case 'thread': return cloudThread(journal, option(values, 'chat'), limitOf(values), values.before)
      default: return cloudChats(journal)
    }
  }
  if (command === 'serve') throw new BridgeError('serve is for cloud mode; set IMSG_BRIDGE_MODE=cloud', 400)
  if (mode === 'photon') {
    const projectId = env.PHOTON_PROJECT_ID, apiKey = env.PHOTON_API_KEY, line = env.PHOTON_IMESSAGE_LINE || undefined
    if (!projectId || !apiKey) throw new BridgeError('Set PHOTON_PROJECT_ID and PHOTON_API_KEY (app.beta.photon.codes)', 400)
    const api = photonApi(projectId, apiKey, env.PHOTON_API_URL || undefined)
    switch (command) {
      case 'pull': return await photonPull(api, values.after)
      case 'reply': return await photonReply(api, option(values, 'chat'), option(values, 'key'), option(values, 'text'), line)
      case 'thread': return await photonThread(api, option(values, 'chat'), limitOf(values), values.before, line)
      default: return await photonChats(api)
    }
  }
  if (mode === 'advanced') {
    const server = await advancedPort(env)
    try {
      switch (command) {
        case 'pull': return await advancedPull(server, values.after)
        case 'reply': return await advancedReply(server, option(values, 'chat'), option(values, 'key'), option(values, 'text'))
        case 'thread': return await advancedThread(server, option(values, 'chat'), limitOf(values), values.before)
        default: return await advancedChats(server)
      }
    } finally { await server.close() }
  }
  const messages = await port()
  try {
    switch (command) {
      case 'pull': return await pull(messages, values.after)
      case 'reply': return await reply(messages, ledger(), option(values, 'chat'), option(values, 'key'), option(values, 'text'))
      case 'thread': return await thread(messages, option(values, 'chat'), limitOf(values), values.before)
      default: return await chats(messages)
    }
  } finally { await messages.close() }
}

/** Runs one command and prints its answer, or its failure in the shape the Source's `CliError` reads. */
export async function run(argv: string[]): Promise<void> {
  try { process.stdout.write(`${JSON.stringify(await main(argv))}\n`) }
  catch (error) {
    const code = error instanceof BridgeError ? error.code : 500
    process.stderr.write(`${JSON.stringify({ error: { code, message: error instanceof Error ? error.message : String(error) } })}\n`)
    process.exitCode = 1
  }
}
