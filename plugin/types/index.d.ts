// Contribution counts keyed by contribution day (local `YYYY-MM-DD`), then by
// source: what the graph draws.
export type Totals = {
  days: Record<string, Record<string, number>>
}

// The mod's own record (ADR 0001): the daily totals, the ID of each prompt
// already counted with when it was sent, so none is counted twice, and per
// transcript file how many bytes the scan has read. Never prompt text. Days
// are kept for the window (365 days), prompt IDs for 30 days. A prompt's ID
// is the last 16 hex digits of its uuid, its time in seconds.
export type ContributionRecord = Totals & {
  version: 3
  prompts: Record<string, number>
  files: Record<string, number>
}

declare module 'claude-code' {
  interface PluginState {
    'prompts-graph': { totals: Shaped<Totals>; autoOpened: boolean }
  }
}
