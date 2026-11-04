import type { Args } from 'claude-code'

// What counts as a contribution. One rule for every path that counts: the scan
// reads a row from its transcript line, live counting from the row
// `session.append` hands over as it is stored, and both key it by the row's
// uuid, the same in the transcript file and at the append (ADR 0002). Not by
// `promptId`: a forked session copies a prompt's line under its own uuid but
// the fork's new `promptId` (2.1.314).
//
// How each kind of user line is marked, confirmed against real transcripts
// (Claude Code 2.1.284 to 2.1.314; samples in tests/fixtures.ts):
// - typed, queued and re-sent prompts, and slash commands that reach Claude:
//   `origin: { kind: "human" }`
// - `claude -p` and other SDK prompts: no `origin`, `turnOrigin: "sdk"` and
//   `promptSource: "sdk"` (`turnOrigin` marks the whole turn, so it is not
//   enough alone: lines with no origin that are not prompts carry no
//   `promptSource`)
// - scheduled tasks: `origin: { kind: "task-notification", subkind:
//   "scheduled-trigger" }`, `turnOrigin: "scheduled"`
// - /loop firings: no `origin`, `isMeta: true`, `promptSource: "system"`,
//   `turnOrigin: "scheduled"`, `wakeupSource: "loop_wakeup"`; the one meta
//   line that counts
// Lines that never count: tool results, multiple-choice answers among them
// (`toolUseResult`, no origin); background task notifications (`origin` kind
// `task-notification` with no `scheduled-trigger` subkind); skill bodies and
// command caveats (`isMeta`, with no `wakeupSource`); built-in local commands such as /clear and
// "[Request interrupted by user]" markers (no origin); compaction summaries
// (`isCompactSummary`); subagent lines (`isSidechain`).
//
// At the append, the same rows carry the prompt's sender as `origin` (the
// person's `composer`, or `bridge` from Remote Control; `sdk`, or for a
// `claude -p` prompt `unclassified`; a schedule's or loop's
// `scheduled-trigger`; the engine's own rows `engine`), a subagent's row its `agentId`, and the
// route it came in by as `door`: a prompt, a slash command, or a prompt folded
// into a running turn (`delivery`); compaction and the message queue's own
// records have doors of their own.

export type Contribution = { id: string; at: number }

type Sender = 'person' | 'sdk' | 'schedule' | 'loop'

// A user-side row, as much of it as the rule reads.
type Row = {
  isPrompt: boolean
  isSubagent: boolean
  isMeta: boolean
  isToolResult: boolean
  sender: Sender | undefined
}

const counts = (row: Row): boolean =>
  row.isPrompt &&
  !row.isSubagent &&
  !row.isToolResult &&
  row.sender !== undefined &&
  (!row.isMeta || row.sender === 'loop')

const holdsToolResult = (content: unknown): boolean =>
  Array.isArray(content) &&
  content.some(
    block => typeof block === 'object' && block !== null && block.type === 'tool_result',
  )

type Line = {
  type?: unknown
  isSidechain?: unknown
  isMeta?: unknown
  isCompactSummary?: unknown
  toolUseResult?: unknown
  origin?: { kind?: unknown; subkind?: unknown }
  turnOrigin?: unknown
  promptSource?: unknown
  wakeupSource?: unknown
  uuid?: unknown
  timestamp?: unknown
  message?: { content?: unknown }
}

const senderOfLine = (line: Line): Sender | undefined => {
  if (line.origin?.kind === 'human') return 'person'
  if (line.turnOrigin === 'sdk' && line.promptSource === 'sdk') return 'sdk'
  if (line.origin?.kind === 'task-notification' && line.origin.subkind === 'scheduled-trigger') {
    return 'schedule'
  }
  if (typeof line.wakeupSource === 'string' && line.turnOrigin === 'scheduled') return 'loop'

  return undefined
}

export const contributionOf = (line: Line): Contribution | undefined => {
  const row: Row = {
    isPrompt: line.type === 'user' && line.isCompactSummary !== true,
    isSubagent: line.isSidechain === true,
    isMeta: line.isMeta === true,
    isToolResult: line.toolUseResult !== undefined || holdsToolResult(line.message?.content),
    sender: senderOfLine(line),
  }
  if (!counts(row)) return undefined
  const at = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN
  if (typeof line.uuid !== 'string' || Number.isNaN(at)) return undefined

  return { id: line.uuid, at }
}

const PROMPT_DOORS: ReadonlySet<string> = new Set(['prompt', 'command', 'delivery'])

const senderOfAppend = (e: Args<'session.append'>): Sender | undefined => {
  switch (e.origin.kind) {
    case 'composer':
    case 'bridge':
      return 'person'
    case 'sdk':
      return 'sdk'
    // A `claude -p` or stream-json SDK prompt (2.1.314), whose line carries
    // no origin; by the command door, a built-in local command such as /cost.
    case 'unclassified':
      return e.door === 'prompt' ? 'sdk' : undefined
    case 'scheduled-trigger':
      return e.message.isMeta === true ? 'loop' : 'schedule'
    default:
      return undefined
  }
}

// Whether a row being stored is a contribution: `e.uuid` is then its ID.
export const countsAppend = (e: Args<'session.append'>): boolean =>
  counts({
    isPrompt: e.message.type === 'user' && PROMPT_DOORS.has(e.door),
    isSubagent: e.agentId !== undefined,
    isMeta: e.message.isMeta === true,
    isToolResult: e.origin.kind === 'tool' || holdsToolResult(e.message.content),
    sender: senderOfAppend(e),
  })

// Every contribution in a transcript's JSONL text; lines that do not parse
// (a line cut short while a session was writing it) are skipped.
export const contributionsIn = (text: string): Contribution[] => {
  const found: Contribution[] = []
  for (const raw of text.split('\n')) {
    if (!raw.includes('"type":"user"')) continue
    let line: unknown
    try {
      line = JSON.parse(raw)
    } catch {
      continue
    }
    if (typeof line !== 'object' || line === null) continue
    const contribution = contributionOf(line as Line)
    if (contribution) found.push(contribution)
  }

  return found
}
