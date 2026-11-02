/** The reply ledger: which idempotency keys were sent, kept in one JSON file written atomically. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface LedgerEntry { state: 'pending' | 'sent'; chatId: string; at: number }
export interface Ledger { get(key: string): LedgerEntry | undefined; set(key: string, entry: LedgerEntry): void }
/** Entries older than this are forgotten: the Source's Outbox stops retrying a message long before. */
export const KEEP_MS = 30 * 24 * 3600_000

export class FileLedger implements Ledger {
  private readonly path: string
  private readonly now: () => number
  constructor(path: string, now: () => number = Date.now) { this.path = path; this.now = now }
  private read(): Record<string, LedgerEntry> {
    try { return JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, LedgerEntry> }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }
  get(key: string): LedgerEntry | undefined { return this.read()[key] }
  set(key: string, entry: LedgerEntry): void {
    const cutoff = this.now() - KEEP_MS
    const kept = Object.fromEntries(Object.entries(this.read()).filter(([, value]) => value.at >= cutoff))
    mkdirSync(dirname(this.path), { recursive: true })
    // Write and rename so a crash leaves the old ledger or the new one, never half of one.
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify({ ...kept, [key]: entry }))
    renameSync(temporary, this.path)
  }
}
export class MemoryLedger implements Ledger {
  readonly entries = new Map<string, LedgerEntry>()
  get(key: string): LedgerEntry | undefined { return this.entries.get(key) }
  set(key: string, entry: LedgerEntry): void { this.entries.set(key, entry) }
}
