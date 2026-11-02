/**
 * The cloud mode's message journal: `imsg-bridge serve` appends every message it sees (people's and the agent's own) as one
 * JSON line, numbered by `rowId`; `pull`, `thread` and `chats` read it. Spectrum streams messages but keeps no history the
 * bridge can page, so the journal is that history.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BridgeMessage } from './bridge.ts'

export interface Journal {
  /** Every complete entry, oldest first. */
  all(): BridgeMessage[]
  /** Appends a message with the next `rowId` (ignoring its own), unless one with the same `id` is already there; returns the stored entry. */
  append(message: Omit<BridgeMessage, 'rowId'>): BridgeMessage
}

export class FileJournal implements Journal {
  private readonly path: string
  constructor(path: string) { this.path = path }
  all(): BridgeMessage[] {
    let text: string
    try { text = readFileSync(this.path, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const entries: BridgeMessage[] = []
    for (const line of text.split('\n')) {
      if (!line) continue
      // A line the writer has not finished is skipped this time and read whole on the next pull.
      try { entries.push(JSON.parse(line) as BridgeMessage) } catch { break }
    }
    return entries
  }
  append(message: Omit<BridgeMessage, 'rowId'>): BridgeMessage {
    const entries = this.all()
    const known = entries.find(entry => entry.id === message.id)
    if (known) return known
    const entry: BridgeMessage = { ...message, rowId: (entries.at(-1)?.rowId ?? 0) + 1 }
    mkdirSync(dirname(this.path), { recursive: true })
    // One short write per line, with O_APPEND, so a reader never sees two entries interleaved.
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`)
    return entry
  }
  /** Drops entries older than `before` (epoch ms), keeping row numbers, so the journal does not grow without end. */
  prune(before: number): number {
    const entries = this.all()
    const kept = entries.filter(entry => Date.parse(entry.at) >= before)
    if (kept.length === entries.length) return 0
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, kept.map(entry => `${JSON.stringify(entry)}\n`).join(''))
    renameSync(temporary, this.path)
    return entries.length - kept.length
  }
}

export class MemoryJournal implements Journal {
  readonly entries: BridgeMessage[] = []
  all(): BridgeMessage[] { return [...this.entries] }
  append(message: Omit<BridgeMessage, 'rowId'>): BridgeMessage {
    const known = this.entries.find(entry => entry.id === message.id)
    if (known) return known
    const entry = { ...message, rowId: (this.entries.at(-1)?.rowId ?? 0) + 1 }
    this.entries.push(entry)
    return entry
  }
}
