import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type { ContributionRecord } from '../types'

import {
  graphOf,
  layoutOf,
  legendSvgOf,
  PALETTE_LABELS,
  paletteNameOf,
  paletteOf,
  type PaletteName,
  SIDE_COLUMNS,
  streakLine,
  svgOf,
  swatchSvgOf,
  terminalOf,
  totalLine,
  type Theme,
} from './graph'
import {
  isNewerRecord,
  isObject,
  recordOf,
  STORE_KEY,
  withCarried,
  withContributions,
  withinWindows,
  withScan,
  type Scan,
} from './record'
import { contributionsIn, countsAppend, type Contribution } from './rule'

const PANE = 'prompts-graph'
const TITLE = 'Prompt Tracker'
// Change the tag when the totals' fields change: it declines what an earlier
// version left in the session, which outlives a reload.
const totals = atom({ plugin: 'prompts-graph', key: 'totals' } as const, { days: {} }, {
  shape: 'totals-1',
})
// Whether the session start opened the pane. A reload starts the session again
// but keeps this, so a pane the person closed stays closed.
const autoOpened = atom({ plugin: 'prompts-graph', key: 'autoOpened' } as const, false)

// `$.fs.read` refuses anything larger.
const READ_LIMIT = 4 * 1024 * 1024

const expandHome = async ($: EngineInterface, path: string): Promise<string> => {
  if (path !== '~' && !path.startsWith('~/')) return path
  const home = await $.env.get('HOME')

  return home === undefined ? path : home + path.slice(1)
}

// The transcriptsDir setting's default.
const DEFAULT_TRANSCRIPTS_DIR = '~/.claude/projects'

// A folder in Claude Code's own: CLAUDE_CONFIG_DIR when that is set, else
// ~/.claude, its `~` left for the caller to expand.
const configPathOf = async ($: EngineInterface, folder: string): Promise<string> => {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')

  return configDir ? `${configDir.replace(/\/+$/, '')}/${folder}` : `~/.claude/${folder}`
}

// Where transcripts are read from. Left at its default, the setting follows
// where Claude Code keeps them: `projects` in its folder.
const transcriptsDirOf = async ($: EngineInterface, setting: string): Promise<string> =>
  setting === DEFAULT_TRANSCRIPTS_DIR ? configPathOf($, 'projects') : setting

const utf8Length = (text: string): number => {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }

  return bytes
}

const HELPER_READ = /^\{"read":(\d+)\}$/

// A transcript's whole lines from byte `from` up to `size`, and how many bytes
// they span; a line the session is still writing waits for the next scan. A
// file read from its start that `$.fs.read` takes is read whole; the rest
// through the helper, which reads only the bytes asked for.
const linesOf = async (
  $: EngineInterface,
  path: string,
  from: number,
  size: number,
): Promise<{ text: string; read: number }> => {
  if (from === 0 && size <= READ_LIMIT) {
    const text = await $.fs.read(path)
    const whole = text.slice(0, text.lastIndexOf('\n') + 1)

    return { text: whole, read: utf8Length(whole) }
  }
  const helper = `${$.plugin.root}/hooks/user-lines.sh`
  const { exitCode, stdout, isStdoutTruncated } = await $.process.run(
    ['/bin/sh', helper, path, String(from), String(size - from)],
    { timeoutMs: 60_000 },
  )
  if (exitCode !== 0) throw new Error(`user-lines.sh exited ${exitCode}`)
  const lines = stdout.trimEnd().split('\n')
  const read = HELPER_READ.exec(lines.at(-1) ?? '')?.[1]
  if (read !== undefined) return { text: lines.slice(0, -1).join('\n'), read: Number(read) }
  if (!isStdoutTruncated) throw new Error('user-lines.sh did not say how far it read')
  // Past 4 MiB of output: what came is counted, and the rest is not read again.
  $.ui.log(`${path} cut at 4 MiB`, { to: 'debug' })

  return { text: stdout, read: size - from }
}

// The contributions in the transcripts folder (each project folder's
// top-level `*.jsonl` sessions) after what `progress` says was read of each
// file, and how far each file is read now. A prompt copied into a resumed
// session's file is found under one ID and counted once.
export const scanTranscripts = async (
  $: EngineInterface,
  transcriptsDir: string,
  progress: Readonly<Record<string, number>>,
): Promise<Scan> => {
  const root = await expandHome($, await transcriptsDirOf($, transcriptsDir))
  const projects = await $.fs.list(root).catch(() => [])
  const byId = new Map<string, Contribution>()
  const files: Record<string, number> = {}
  let isComplete = true
  for (const project of projects) {
    if (project.kind !== 'dir') continue
    const folder = `${root}/${project.name}`
    const entries = await $.fs.list(folder).catch(() => [])
    for (const file of entries) {
      if (file.kind !== 'file' || !file.name.endsWith('.jsonl')) continue
      const path = `${folder}/${file.name}`
      // A file now shorter than what was read of it is another file.
      const readBefore = progress[path] ?? 0
      const from = readBefore > file.size ? 0 : readBefore
      files[path] = from
      if (file.size === from) continue
      try {
        const { text, read } = await linesOf($, path, from, file.size)
        files[path] = from + read
        for (const one of contributionsIn(text)) byId.set(one.id, one)
      } catch (error) {
        isComplete = false
        $.ui.log(`skipped ${path}: ${String(error)}`, { to: 'debug' })
      }
    }
  }

  return { found: [...byId.values()], files, isComplete }
}

// Each change to the record waits for the one before, so a prompt counted live
// while a scan runs is never written over by the scan's merge. Every change
// keeps the record to its windows, so its size levels off. A record a later
// release wrote is left as it is.
let saving: Promise<unknown> = Promise.resolve()

const save = (
  $: EngineInterface,
  change: (record: ContributionRecord, now: number) => ContributionRecord,
): Promise<void> => {
  const run = saving.then(async () => {
    const now = await $.clock.now()
    const stored = await $.store.get(STORE_KEY)
    if (isNewerRecord(stored)) return
    const changed = withinWindows(change(recordOf(stored), now), now)
    await $.store.set(STORE_KEY, changed)
    await update($, totals, () => ({ days: changed.days }))
  })
  saving = run.catch(() => undefined)

  return run
}

// The terminal draws in Claude Code's own theme; the graphical surfaces' SVG
// follows the host's appearance by itself.
const terminalTheme = async ($: EngineInterface): Promise<Theme> => {
  const rows = await $.config.list().catch(() => [])
  const theme = rows.find(row => row.key === 'theme')?.value

  return typeof theme === 'string' && theme.startsWith('light') ? 'light' : 'dark'
}

// The mod's earlier names: claude-contributions, which Claude Code reserves,
// then contributions-graph. Each kept a store file for each place it was
// loaded from (`inline` for a clone), named `<name>_<place>-<hash>.json`, in
// the folder every plugin's store is kept in, each value under its key.
const OLD_STORE = /^(claude-contributions|contributions-graph)_.+\.json$/
// The store key listing the earlier names' store files already carried over.
const CARRIED_KEY = 'carried'

// Folds the record each old store file holds into this one, once per file:
// the one copy of days older than the transcripts. A file that cannot be read
// or holds no record is tried again at the next session start.
const carryOver = async ($: EngineInterface): Promise<void> => {
  const dir = await expandHome($, await configPathOf($, 'plugins/store'))
  const entries = await $.fs.list(dir).catch(() => [])
  const stored = await $.store.get(CARRIED_KEY)
  const carried = Array.isArray(stored) ? stored.filter(name => typeof name === 'string') : []
  const before = carried.length
  for (const entry of entries) {
    if (entry.kind !== 'file' || !OLD_STORE.test(entry.name) || carried.includes(entry.name)) continue
    try {
      const old: unknown = JSON.parse(await $.fs.read(`${dir}/${entry.name}`))
      const record = isObject(old) ? old[STORE_KEY] : undefined
      if (!isObject(record) || !isObject(record.days)) throw new Error('no record in it')
      await save($, (ours, now) => withCarried(ours, recordOf(record), now))
      carried.push(entry.name)
    } catch (error) {
      $.ui.log(`not carried over ${entry.name}: ${String(error)}`, { to: 'debug' })
    }
  }
  if (carried.length > before) await $.store.set(CARRIED_KEY, carried)
}

// Shows the totals as stored, then counts what is new in the transcripts,
// unless a later release wrote the record and it cannot be counted into.
// First it carries over what the mod kept under its earlier names.
const refresh = async ($: EngineInterface, transcriptsDir: string) => {
  const raw = await $.store.get(STORE_KEY)
  const stored = recordOf(raw)
  await update($, totals, () => ({ days: stored.days }))
  if (isNewerRecord(raw)) {
    $.ui.log('the record is from a later version of the mod; not counting into it', { to: 'debug' })
    return
  }
  await carryOver($)
  const scan = await scanTranscripts($, transcriptsDir, stored.files)
  await save($, (record, now) => withScan(record, scan, now))
}

const logFailure = ($: EngineInterface, what: string) => (error: unknown) =>
  $.ui.log(`${what} failed: ${String(error)}`, { to: 'debug' })

const untilMidnight = (now: number): number => {
  const today = new Date(now)

  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime() - now
}

// At each local midnight the window moves on a day while the session stays
// open: the record drops the day that left it, and the pane draws today's
// square. One timer, however many times the session starts.
let midnight: Timer | undefined

const rollOverAtMidnight = async ($: EngineInterface): Promise<void> => {
  midnight?.cancel()
  midnight = $.clock.after(untilMidnight(await $.clock.now()), () => {
    // No change: saving alone prunes the record to the new day.
    void save($, record => record)
      .then(() => $.ui.invalidate('ui.render'))
      .catch(logFailure($, 'day rollover'))
      .finally(() => rollOverAtMidnight($).catch(logFailure($, 'day rollover')))
  })
}

// Opening the pane while it is open only retitles it. Opened unasked, at a
// session start or a /clear, it is placed only from 144 columns; narrower, it
// waits undrawn for a wider terminal or for /prompts-graph, which places it at
// any width. Docked, it asks for the narrowest dock there is, where the
// vertical grid draws at its own size: 24 columns, the least a dock opens at,
// which the surface raises to its own least. A width the person dragged the
// dock to wins.
const DOCK_COLUMNS = 24
// How wide, in CSS pixels, the editor draws the vertical grid: as its
// narrowest dock shrinks it to.
const EDITOR_VERTICAL_WIDTH = 190
// The shade of the palette the button switches to that the editor's swatch shows.
const SWATCH_SHADE = 3

const openPane = async ($: EngineInterface): Promise<void> => {
  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: DOCK_COLUMNS })
  if (!opened.isPlaced) $.ui.log(`pane not placed: ${opened.reason}`, { to: 'debug' })
}

// The palette the graph is drawn in, from the setting when the module loads
// and from each change to it after.
let paletteName: PaletteName = 'clay'
let palette = paletteOf(paletteName)

const showPalette = ($: EngineInterface, value: unknown): void => {
  paletteName = paletteNameOf(value)
  palette = paletteOf(paletteName)
  $.ui.invalidate('ui.render')
}

// A palette control writes the setting, so the choice lasts and /config
// shows it. The plugin's own config.set hook skips its own writes, so the
// pane is redrawn here. Where the setting has no /config row to write, as in
// a VS Code session with the mod installed from a marketplace (Claude Code
// 2.1.317), the choice is kept in the store instead, with the setting's value
// it was made over: a setting changed since then wins.
const PALETTE_KEY = 'palette'
// The palette setting's value as this module loaded it.
let settingPalette: PaletteName = 'clay'

type PaletteChoice = { name: PaletteName; over: PaletteName }

const isPaletteChoice = (value: unknown): value is PaletteChoice =>
  isObject(value) &&
  paletteNameOf(value.name) === value.name &&
  paletteNameOf(value.over) === value.over

const keepChoice = async ($: EngineInterface, name: PaletteName, why: string): Promise<void> => {
  $.ui.log(`palette setting not written (${why}); kept in the store`, { to: 'debug' })
  const choice: PaletteChoice = { name, over: settingPalette }
  await $.store.set(PALETTE_KEY, choice)
  showPalette($, name)
}

const choosePalette = async ($: EngineInterface, name: PaletteName): Promise<void> => {
  const set = await $.config.set({ key: 'prompts-graph.palette', value: name }).catch((error: unknown) => ({
    deny: String(error),
  }))
  if ('deny' in set && set.deny !== undefined) return keepChoice($, name, set.deny)
  await $.store.delete(PALETTE_KEY)
  showPalette($, set.value)
}

// The palette a choice kept in the store left, unless the setting changed
// since it was made, which drops the choice.
const restorePalette = async ($: EngineInterface): Promise<void> => {
  const choice = await $.store.get(PALETTE_KEY)
  if (choice === undefined) return
  if (isPaletteChoice(choice) && choice.over === settingPalette) {
    showPalette($, choice.name)
    return
  }
  await $.store.delete(PALETTE_KEY)
}

export const register: Register = (on, options) => {
  const transcriptsDir = String(options.transcriptsDir ?? DEFAULT_TRANSCRIPTS_DIR)
  // On unless turned off: off, the pane opens only through /prompts-graph.
  const autoOpen = options.autoOpen !== false
  settingPalette = paletteNameOf(options.palette)
  paletteName = settingPalette
  palette = paletteOf(paletteName)

  // A palette chosen while the pane is open redraws it in the new colors
  // straight away, without waiting for the reload the change brings. The hook
  // only watches: it hands the change on unchanged, as the plugin directory
  // requires of a config.set hook. A change another plugin then refuses shows
  // until that reload, which draws the setting as it stands.
  on('config.set', { key: 'prompts-graph.palette' }, ($, e, next) => {
    settingPalette = paletteNameOf(e.value)
    showPalette($, e.value)
    void $.store.delete(PALETTE_KEY).catch(logFailure($, 'palette choice'))

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prompts-graph',
      description: 'Show your prompts graph',
    })
    const started = await next(e)
    await restorePalette($).catch(logFailure($, 'palette restore'))
    // A first scan reads every transcript, so it runs after the session starts.
    void refresh($, transcriptsDir).catch(logFailure($, 'scan'))
    await rollOverAtMidnight($)
    if (autoOpen && !(await read($, autoOpened))) {
      await update($, autoOpened, () => true)
      await openPane($)
    }

    return started
  })

  // A /clear ends the conversation, not the process, and no session start
  // follows it. A pane outlives it: a pane closes only by this plugin's call,
  // the person's close, or an unload (`ui.close`'s origins), and /clear is none
  // of them. With auto-open on, it is opened again anyway, which retitles a
  // pane still open, so the graph shows after /clear even if a later release
  // closes panes there.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    if (autoOpen && e.reason === 'clear') await openPane($)

    return ended
  })

  // Counts a prompt the moment its row is stored. Every row of every
  // conversation passes here, so this goes on across a /clear, which starts a
  // new conversation without a new session start.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (countsAppend(e)) {
      const found = { id: e.uuid, at: await $.clock.now() }
      void save($, (record, now) => withContributions(record, [found], now)).catch(
        logFailure($, 'live count'),
      )
    }

    return stored
  })

  on('command.run', { command: 'prompts-graph' }, async $ => {
    await openPane($)

    return { text: 'Prompts graph opened.' }
  })

  // The grid is a Raster on the terminal, which has no Svg, and an Svg on
  // desktop, vscode and mobile, which have no Raster: no one element is drawn
  // on every surface.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const graph = graphOf(await read($, totals), await $.clock.now())
    const total = totalLine(graph.total)
    const streaks = streakLine(graph)
    const layout = layoutOf(e.surface, e.props.bodyColumns, graph.weeks.length)
    const { Box, Text, Button } = $.ui.resolve(e)
    const press = (name: PaletteName) => () =>
      void choosePalette($, name).catch(logFailure($, 'palette change'))
    const other: PaletteName = paletteName === 'clay' ? 'green' : 'clay'
    // One button, named for the palette it switches to. The desktop draws its
    // native button in its own accent, which matches the squares. The editor
    // draws every button in its theme's colors whatever the mod asks, so there
    // it is the quieter secondary button, a square of the palette it switches
    // to beside it.
    const label = PALETTE_LABELS[other]
    // `swatch`, the editor's square, is drawn by the caller, which has its Svg.
    const controlsWith = (swatch?: RenderChildren) =>
      swatch === undefined ? (
        <Box flexDirection="row">
          <Button key="palette" hotkey="p" onPress={press(other)}>
            {label}
          </Button>
        </Box>
      ) : (
        <Box flexDirection="row" alignItems="center" gap="sm">
          <Button key="palette" hotkey="p" variant="secondary" onPress={press(other)}>
            {label}
          </Button>
          {swatch}
        </Box>
      )
    const headline = (
      <Box flexDirection="column" marginBottom="md">
        <Text weight="semibold" size="heading">{total}</Text>
        <Text dimColor size="footnote">{streaks}</Text>
      </Box>
    )
    // Vertical, the grid runs far down the pane, so the legend goes above it;
    // horizontal, below it, as on GitHub. The palette button sits between the
    // two, each a row apart, the least space the terminal and the editor draw
    // down.
    const around = (grid: RenderChildren[], legend: RenderChildren, controls = controlsWith()) =>
      layout === 'vertical'
        ? [<Box marginBottom="md">{legend}</Box>, <Box marginBottom="md">{controls}</Box>, ...grid]
        : [...grid, <Box marginTop="md">{controls}</Box>, <Box marginTop="md">{legend}</Box>]
    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      const theme = await terminalTheme($)
      const { raster, top, side } = terminalOf(graph, palette, theme, e.props.bodyColumns, layout)
      // The side labels' column, when the pane has room for it.
      const gutter = (...children: RenderChildren[]) =>
        side === undefined ? [] : [<Box width={SIDE_COLUMNS}>{children}</Box>]
      const legend = palette[theme].flatMap(color => [' ', <Text color={color}>■</Text>])

      return (
        <Box flexDirection="column">
          {headline}
          {around(
            [
              <Box flexDirection="row">
                {gutter()}
                <Text>{top}</Text>
              </Box>,
              <Box flexDirection="row">
                {gutter(<Text>{side}</Text>)}
                <Raster key="grid" {...raster} />
              </Box>,
            ],
            <Text>Less{legend} More</Text>,
          )}
        </Box>
      )
    }
    const { Svg } = $.ui.resolve(e)
    // The editor draws an image, and a pane narrower than the grid shrinks it
    // to the pane's width; a height kept would leave the box its full height,
    // the shrunken grid centered in it. Without one, the box is the grid's.
    // The editor's dock opens wider than the grid and takes no width from the
    // mod, so its vertical grid is drawn at the scale of the narrowest dock
    // however wide the pane is.
    const { height, ...picture } = svgOf(graph, palette, layout)
    const sized =
      e.surface !== 'vscode'
        ? { ...picture, height }
        : layout === 'vertical'
          ? { ...picture, width: EDITOR_VERTICAL_WIDTH }
          : picture

    return (
      <Box flexDirection="column">
        {headline}
        {around(
          [<Svg {...sized} alt={`Prompts graph: ${total}. ${streaks}.`} isInteractive />],
          <Svg {...legendSvgOf(palette)} alt="Less to More, in five shades" />,
          e.surface === 'vscode'
            ? controlsWith(<Svg {...swatchSvgOf(paletteOf(other), SWATCH_SHADE)} alt={`${label} swatch`} />)
            : undefined,
        )}
      </Box>
    )
  })
}
