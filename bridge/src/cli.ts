/**
 * `imsg-bridge`: the iMessage Source's CLI. Two modes, chosen by `IMSG_BRIDGE_MODE`:
 *
 * - `local` (default): reads chat.db and sends through Messages.app with Photon's imessage-kit. Needs macOS, the agent's
 *   Apple ID signed in to Messages, and Full Disk Access for the process that runs it.
 * - `cloud`: Photon Spectrum Cloud holds the iMessage line, so any host works, Linux included. `imsg-bridge serve` runs
 *   alongside the service with `PHOTON_PROJECT_ID` and `PHOTON_PROJECT_SECRET`; the other commands read its journal.
 *
 *   imsg-bridge pull [--after <cursor>] --json
 *   imsg-bridge reply --chat <chatId> --key <key> --text <text>
 *   imsg-bridge thread --chat <chatId> [--limit <n>] [--before <iso time>] --json
 *   imsg-bridge chats --json
 *   imsg-bridge serve                       (cloud mode only; runs until stopped)
 *
 * Output is JSON on stdout. A failure prints `{"error":{"code","message"}}` on stderr and exits 1.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { BridgeError, chats, pull, reply, thread, type MessagesPort } from './bridge.ts'
import { cloudChats, cloudPull, cloudReply, cloudThread } from './cloud.ts'
import { FileJournal } from './journal.ts'
import { FileLedger } from './ledger.ts'
import { httpSender, readEndpoint, serve } from './serve.ts'

const HOME = process.env.IMSG_BRIDGE_HOME || join(homedir(), '.imsg-bridge')
const COMMANDS = ['pull', 'reply', 'thread', 'chats', 'serve']

export type Mode = 'local' | 'cloud'
export function modeOf(env: NodeJS.ProcessEnv = process.env): Mode {
  const mode = env.IMSG_BRIDGE_MODE || 'local'
  if (mode !== 'local' && mode !== 'cloud') throw new BridgeError(`IMSG_BRIDGE_MODE must be local or cloud, not ${mode}`, 400)
  return mode
}

async function port(): Promise<MessagesPort & { close(): Promise<void> }> {
  const { IMessageSDK } = await import('@photon-ai/imessage-kit')
  return new IMessageSDK()
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

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
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
