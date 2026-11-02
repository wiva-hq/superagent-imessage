import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { BridgeError } from '../src/bridge.ts'
import { withBridgeEnv } from '../src/cli.ts'

const run = promisify(execFile)
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'imsg-bridge')

function home(contents?: string, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), 'imsg-env-'))
  if (contents !== undefined) {
    writeFileSync(join(dir, 'bridge.env'), contents)
    chmodSync(join(dir, 'bridge.env'), mode)
  }
  return dir
}

describe('bridge.env', () => {
  it('adds its variables where the environment has none, and the environment wins', () => {
    const dir = home('# Photon v2\nIMSG_BRIDGE_MODE=photon\nPHOTON_API_KEY="pho_sk_file"\n\nPHOTON_PROJECT_ID = pho_prj_file \nnot a line\n')
    expect(withBridgeEnv({ IMSG_BRIDGE_HOME: dir, PHOTON_PROJECT_ID: 'pho_prj_env' })).toEqual({
      IMSG_BRIDGE_HOME: dir, IMSG_BRIDGE_MODE: 'photon', PHOTON_API_KEY: 'pho_sk_file', PHOTON_PROJECT_ID: 'pho_prj_env',
    })
  })

  it('is optional', () => {
    const dir = home()
    expect(withBridgeEnv({ IMSG_BRIDGE_HOME: dir })).toEqual({ IMSG_BRIDGE_HOME: dir })
  })

  it('refuses a file other users can read', () => {
    const dir = home('PHOTON_API_KEY=pho_sk_file\n', 0o644)
    expect(() => withBridgeEnv({ IMSG_BRIDGE_HOME: dir })).toThrow(BridgeError)
    expect(() => withBridgeEnv({ IMSG_BRIDGE_HOME: dir })).toThrow(/chmod 600/)
  })

  it('reaches the bridge when the service’s environment has lost the key, as under DeepSeek Harness', async () => {
    let auth: string | undefined
    const server = createServer((request, response) => {
      auth = request.headers.authorization
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"items":[]}')
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const dir = home(`IMSG_BRIDGE_MODE=photon\nPHOTON_PROJECT_ID=pho_prj_0000000000000000000000000a\nPHOTON_API_KEY=pho_sk_file\nPHOTON_API_URL=${url}\n`)
      const env = { PATH: process.env.PATH, HOME: process.env.HOME, IMSG_BRIDGE_HOME: dir }
      expect(JSON.parse((await run(BIN, ['chats', '--json'], { env })).stdout)).toEqual([])
      expect(auth).toBe('Bearer pho_sk_file')
    } finally { await new Promise(resolve => { server.close(resolve) }) }
  })
})
