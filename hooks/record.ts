import type { ContributionRecord, Totals } from '../types'

import type { Contribution } from './rule'

export const SOURCE = 'claude-code'
export const STORE_KEY = 'record'

export const RECORD_VERSION = 3

export const emptyRecord = (): ContributionRecord => ({
  version: RECORD_VERSION,
  days: {},
  prompts: {},
  files: {},
})

const pad = (n: number): string => String(n).padStart(2, '0')

// The contribution day of a moment: its date in this computer's time zone.
export const dayKey = (at: number | Date): string => {
  const date = new Date(at)

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

// A prompt is kept under the last 16 hex digits of its uuid, about 62 random
// bits: no two of the prompts kept will share them. An ID that is not a uuid
// is kept whole.
const promptKey = (id: string): string => {
  const hex = id.replaceAll('-', '')

  return /^[0-9a-f]{32}$/i.test(hex) ? hex.slice(-16).toLowerCase() : id
}

const seconds = (at: number): number => Math.floor(at / 1000)

// Whether the store holds a record a later release wrote, which this one must
// not write over: it would drop what it cannot read.
export const isNewerRecord = (stored: unknown): boolean =>
  isObject(stored) && typeof stored.version === 'number' && stored.version > RECORD_VERSION

// Version 1 kept daily totals alone; it loads as a record no scan has read
// into yet, so the next scan merges into its totals instead of adding to them.
// Version 2 kept each prompt's whole uuid and its time in milliseconds. A
// later version's totals are shown as they are, if they read as totals.
export const recordOf = (stored: unknown): ContributionRecord => {
  if (!isObject(stored) || !isObject(stored.days)) return emptyRecord()
  const days = stored.days as ContributionRecord['days']
  if (stored.version === 1 || isNewerRecord(stored)) return { ...emptyRecord(), days }
  if (!isObject(stored.prompts) || !isObject(stored.files)) return emptyRecord()
  const files = stored.files as ContributionRecord['files']
  const prompts = stored.prompts as Record<string, number>
  if (stored.version === 2) {
    const kept = Object.entries(prompts).map(([id, at]) => [promptKey(id), seconds(at)])

    return { ...emptyRecord(), days, prompts: Object.fromEntries(kept), files }
  }
  if (stored.version !== RECORD_VERSION) return emptyRecord()

  return { ...emptyRecord(), days, prompts, files }
}

// Daily totals are kept for the window, and prompt IDs for as long as Claude
// Code keeps transcripts to find them in again (ADR 0001).
export const WINDOW_DAYS = 365
const PROMPT_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

// The first contribution day of the window ending on the day of `now`.
const firstDayOf = (now: number): string => {
  const today = new Date(now)

  return dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (WINDOW_DAYS - 1)))
}

const promptCutoff = (now: number): number => now - PROMPT_DAYS * DAY_MS

// At about 30 bytes a prompt, this many keep the record under 2.5 MB, well
// inside the store's 4 MiB: 30 days at about 2,700 prompts a day. Past it the
// oldest IDs go first, and only a prompt of theirs found again by a scan could
// count twice.
export const MAX_PROMPTS = 80_000

// The record as of `now`: days before the window and prompt IDs older than
// 30 days dropped, and the oldest IDs past MAX_PROMPTS.
export const withinWindows = (record: ContributionRecord, now: number): ContributionRecord => {
  const first = firstDayOf(now)
  const since = seconds(promptCutoff(now))
  const prompts = Object.entries(record.prompts).filter(([, at]) => at >= since)
  if (prompts.length > MAX_PROMPTS) prompts.sort(([, a], [, b]) => b - a).length = MAX_PROMPTS

  return {
    ...record,
    days: Object.fromEntries(Object.entries(record.days).filter(([day]) => day >= first)),
    prompts: Object.fromEntries(prompts),
  }
}

// Adds the contributions not counted before, each to its day. A prompt older
// than 30 days is not added: its ID may have been dropped after it was
// counted, and a resumed session copies its line into a new file.
export const withContributions = (
  record: ContributionRecord,
  found: readonly Contribution[],
  now: number,
): ContributionRecord => {
  const since = promptCutoff(now)
  const days = { ...record.days }
  const prompts = { ...record.prompts }
  for (const { id, at } of found) {
    const key = promptKey(id)
    if (key in prompts || at < since) continue
    prompts[key] = seconds(at)
    const day = dayKey(at)
    days[day] = { ...days[day], [SOURCE]: (days[day]?.[SOURCE] ?? 0) + 1 }
  }

  return { ...record, days, prompts }
}

// What a scan found, how far it read each file, and whether it read every
// file it listed.
export type Scan = {
  found: readonly Contribution[]
  files: Record<string, number>
  isComplete: boolean
}

const countByDay = (ats: Iterable<number>): Map<string, number> => {
  const byDay = new Map<string, number>()
  for (const at of ats) byDay.set(dayKey(at), (byDay.get(dayKey(at)) ?? 0) + 1)

  return byDay
}

// Folds a scan into the record. After a scan has read files, only prompts not
// counted before are added. Until then the record's totals may hold prompts it
// kept no ID for (version 1), which the scan, reading every transcript from
// the start, finds again: each day's prompts without an ID are taken to be
// those the scan found, unless the record held more, and the prompts counted
// by ID (live, while the scan ran) are added on top. A scan that could not
// read a file leaves this to the next scan, which reads every file again.
export const withScan = (record: ContributionRecord, scan: Scan, now: number): ContributionRecord => {
  if (Object.keys(record.files).length > 0) {
    return { ...withContributions(record, scan.found, now), files: scan.files }
  }
  const keyed = countByDay(Object.values(record.prompts).map(at => at * 1000))
  const unseen = countByDay(
    scan.found.filter(({ id }) => !(promptKey(id) in record.prompts)).map(({ at }) => at),
  )
  const days = { ...record.days }
  for (const [day, count] of unseen) {
    const withId = keyed.get(day) ?? 0
    const withoutId = Math.max(0, (days[day]?.[SOURCE] ?? 0) - withId)
    days[day] = { ...days[day], [SOURCE]: Math.max(withoutId, count) + withId }
  }
  const prompts = { ...record.prompts }
  for (const { id, at } of scan.found) prompts[promptKey(id)] = seconds(at)

  return { ...record, days, prompts, files: scan.isComplete ? scan.files : {} }
}

// Per day, how many prompts the record keeps an ID for, and how many of those
// IDs `others` lacks.
const keyedByDay = (record: ContributionRecord, others: Readonly<Record<string, number>>) => {
  const keyed = new Map<string, { all: number; othersLack: number }>()
  for (const [key, at] of Object.entries(record.prompts)) {
    const day = dayKey(at * 1000)
    const counted = keyed.get(day) ?? { all: 0, othersLack: 0 }
    keyed.set(day, { all: counted.all + 1, othersLack: counted.othersLack + (key in others ? 0 : 1) })
  }

  return keyed
}

// Folds in another record of the same prompts, which counted some the record
// did not: what the mod kept under its first name. No prompt counts twice.
// Each record's count of a day is all it is sure of; a prompt the other kept
// an ID for that this record lacks adds to it, unless it may be one this
// record counted without an ID. A day is given the larger of the two sums,
// which, both records keeping every ID, is every prompt either counted.
// Folding the same record in again changes nothing.
export const withCarried = (record: ContributionRecord, carried: unknown, now: number): ContributionRecord => {
  const ours = withinWindows(record, now)
  const theirs = withinWindows(recordOf(carried), now)
  const oursKeyed = keyedByDay(ours, theirs.prompts)
  const theirsKeyed = keyedByDay(theirs, ours.prompts)
  // One side's count of a day, raised by the IDs the other kept that it lacks.
  const raised = (
    count: number,
    own: { all: number } | undefined,
    other: { othersLack: number } | undefined,
  ): number => count + Math.max(0, (other?.othersLack ?? 0) - Math.max(0, count - (own?.all ?? 0)))
  const days = { ...ours.days }
  for (const [day, sources] of Object.entries(theirs.days)) {
    const merged = { ...days[day] }
    for (const [source, count] of Object.entries(sources)) {
      const our = merged[source] ?? 0
      merged[source] =
        source === SOURCE
          ? Math.max(
              raised(our, oursKeyed.get(day), theirsKeyed.get(day)),
              raised(count, theirsKeyed.get(day), oursKeyed.get(day)),
            )
          : Math.max(our, count)
    }
    days[day] = merged
  }

  return { ...ours, days, prompts: { ...theirs.prompts, ...ours.prompts } }
}

// A day's contribution count, summed across every source.
export const countOn = (totals: Totals, day: string): number =>
  Object.values(totals.days[day] ?? {}).reduce((sum, n) => sum + n, 0)
