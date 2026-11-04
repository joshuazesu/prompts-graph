import type { RenderSurface } from 'claude-code'

import type { Totals } from '../types'

import { countOn, dayKey, WINDOW_DAYS } from './record'

// The hooks environment has the ES2025 base64 methods; es2023's lib lacks them.
declare global {
  interface Uint8Array {
    toBase64(): string
  }
}

export type Shade = 0 | 1 | 2 | 3 | 4
export type Theme = 'light' | 'dark'

// A palette's colors per theme: empty, then the four levels, from the
// approved color draft.
export type Palette = Record<Theme, readonly string[]>

// Claude Clay and GitHub Green, by the names the `palette` setting takes.
const PALETTES: Record<string, Palette> = {
  clay: {
    light: ['#efebe7', '#f6cdb9', '#eb9c7a', '#d4693f', '#9c4223'],
    dark: ['#2a2725', '#5a2f1f', '#8f4227', '#cf6a43', '#f29a72'],
  },
  green: {
    light: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'],
    dark: ['#2a2c2e', '#0e4429', '#006d32', '#26a641', '#39d353'],
  },
}

export type PaletteName = 'clay' | 'green'

// What the palette controls call each palette.
export const PALETTE_LABELS: Record<PaletteName, string> = { clay: 'Claude Clay', green: 'GitHub Green' }

// A setting of anything but the two palettes draws in Claude Clay.
export const paletteNameOf = (name: unknown): PaletteName => (name === 'green' ? 'green' : 'clay')

export const paletteOf = (name: unknown): Palette => PALETTES[paletteNameOf(name)]!

export type Day = { key: string; count: number; shade: Shade }

// The window as Sunday-first weeks, oldest first: `weeks[w][weekday]`, with
// no day before the window's first or after today. The streaks are runs of
// days with a contribution: the one running back from today, and the
// window's longest.
export type Graph = {
  weeks: (Day | undefined)[][]
  total: number
  currentStreak: number
  longestStreak: number
}

// Nearest-rank percentile of counts sorted ascending.
const percentile = (sorted: readonly number[], p: number): number =>
  sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0

// The four shades step evenly up to a busy day, the 90th percentile of the
// active days, so one outlier does not wash every other day out.
const shadeOf = (count: number, busy: number): Shade =>
  count === 0 ? 0 : (Math.min(4, Math.max(1, Math.ceil((4 * count) / Math.max(1, busy)))) as Shade)

const streaksOf = (counts: readonly number[]): { current: number; longest: number } => {
  let longest = 0
  let run = 0
  for (const n of counts) {
    run = n > 0 ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  // A quiet today does not break the streak yet: the day is not over.
  let at = counts.length - 1
  if (counts[at] === 0) at--
  let current = 0
  for (; at >= 0 && (counts[at] ?? 0) > 0; at--) current++

  return { current, longest }
}

export const graphOf = (totals: Totals, now: number): Graph => {
  const today = new Date(now)
  const dates = Array.from(
    { length: WINDOW_DAYS },
    (_, i) =>
      new Date(today.getFullYear(), today.getMonth(), today.getDate() - (WINDOW_DAYS - 1 - i)),
  )
  const counts = dates.map(date => countOn(totals, dayKey(date)))
  const active = counts.filter(n => n > 0).sort((a, b) => a - b)
  const busy = percentile(active, 0.9)
  const lead = dates[0]?.getDay() ?? 0
  const weeks: (Day | undefined)[][] = []
  dates.forEach((date, i) => {
    const slot = lead + i
    const week = (weeks[Math.floor(slot / 7)] ??= Array<Day | undefined>(7).fill(undefined))
    const count = counts[i] ?? 0
    week[slot % 7] = { key: dayKey(date), count, shade: shadeOf(count, busy) }
  })
  const { current, longest } = streaksOf(counts)

  return {
    weeks,
    total: counts.reduce((sum, n) => sum + n, 0),
    currentStreak: current,
    longestStreak: longest,
  }
}

const plural = (count: number, one: string): string =>
  `${count.toLocaleString('en-US')} ${one}${count === 1 ? '' : 's'}`

export const totalLine = (total: number): string => `${plural(total, 'prompt')} in the last year`

export const streakLine = ({ currentStreak, longestStreak }: Graph): string =>
  `Current streak ${plural(currentStreak, 'day')} · Longest ${plural(longestStreak, 'day')}`

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// The local date a day's key names.
const dateOf = (key: string): Date => {
  const [year = 0, month = 1, date = 1] = key.split('-').map(Number)

  return new Date(year, month - 1, date)
}

// A square's tooltip, on one line: "23 prompts on Tue, Nov 3".
export const tooltipOf = ({ key, count }: Day): string => {
  const date = dateOf(key)
  const what = count === 0 ? 'No prompts' : plural(count, 'prompt')

  return `${what} on ${WEEKDAY_NAMES[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`
}

// Horizontal, like GitHub, when the pane is wide enough for every week:
// weeks left to right, newest on the right. Narrower, vertical: weekdays
// across, weeks down, newest on top, so today shows without scrolling and
// nothing scrolls sideways. Docked or inline, only the width decides.
export type Layout = 'horizontal' | 'vertical'

// About how many pixels a body column is on the graphical surfaces, which
// size their panes in the terminal's columns.
const PX_PER_COLUMN = 7.6

export const layoutOf = (
  surface: RenderSurface,
  bodyColumns: number,
  weeks: number,
): Layout => {
  const fits =
    surface === 'terminal'
      ? // A square per week, the gaps closed up, beside the side labels.
        bodyColumns >= SIDE_COLUMNS + weeks
      : bodyColumns * PX_PER_COLUMN >= LEFT + weeks * PITCH - (PITCH - CELL) + PAD.horizontal

  return fits ? 'horizontal' : 'vertical'
}

// A label at a column of the grid (along its top) or a row (down its side).
type Label = { at: number; text: string }

// The graph's squares laid out on a grid `across` squares wide and `down`
// tall, each at its column `x` and row `y`, and the labels along its top and
// down its side.
type Grid = {
  across: number
  down: number
  squares: { day: Day; x: number; y: number }[]
  top: Label[]
  side: Label[]
}

// Each month's label goes on the first week whose Sunday falls in it.
const monthsOf = ({ weeks }: Graph): Label[] =>
  weeks.flatMap((week, w) => {
    const weekday = week.findIndex(day => day !== undefined)
    const day = dateOf(week[weekday]?.key ?? '')
    const sunday = new Date(day.getFullYear(), day.getMonth(), day.getDate() - weekday)

    return sunday.getDate() <= 7 ? [{ at: w, text: MONTHS[sunday.getMonth()] ?? '' }] : []
  })

const WEEKDAYS: Label[] = [
  { at: 1, text: 'Mon' },
  { at: 3, text: 'Wed' },
  { at: 5, text: 'Fri' },
]
const WEEKDAY_INITIALS: Label[] = [...'SMTWTFS'].map((text, at) => ({ at, text }))

const gridOf = (graph: Graph, layout: Layout): Grid => {
  const { weeks } = graph
  const isVertical = layout === 'vertical'
  const squares = weeks.flatMap((week, w) =>
    week.flatMap((day, weekday) =>
      day === undefined
        ? []
        : [isVertical ? { day, x: weekday, y: weeks.length - 1 - w } : { day, x: w, y: weekday }],
    ),
  )
  const months = monthsOf(graph)

  return isVertical
    ? {
        across: 7,
        down: weeks.length,
        squares,
        top: WEEKDAY_INITIALS,
        side: months.map(({ at, text }) => ({ at: weeks.length - 1 - at, text })).reverse(),
      }
    : {
        across: weeks.length,
        down: 7,
        squares,
        // A month starting in the last week has no room for its label.
        top: months.filter(({ at }) => at < weeks.length - 1),
        side: WEEKDAYS,
      }
}

const CELL = 10
const PITCH = 13
// Docked, the squares are GitHub's scaled up, gaps and all, so the grid's
// seven columns fill the desktop's narrowest dock, about 240px.
const SIZES: Record<Layout, { cell: number; pitch: number }> = {
  horizontal: { cell: CELL, pitch: PITCH },
  vertical: { cell: 24, pitch: 31 },
}
// Under the pointer a square is drawn this much bigger, with an outline;
// the room it needs past the grid's right and bottom edges.
const GROW = 1.6
const outsetOf = (cell: number): number => Math.ceil((Math.round(cell * GROW) - cell) / 2) + 2
const PAD: Record<Layout, number> = {
  horizontal: outsetOf(SIZES.horizontal.cell),
  vertical: outsetOf(SIZES.vertical.cell),
}
// Room for the labels down the left and along the top, and where a label's
// baseline sits: in the top margin, or a row's square.
const LEFT = 28
const TOP = 16
const TOP_BASELINE = 10
const ROW_BASELINE = 9

// The draft's muted label color.
const LABEL: Record<Theme, string> = { light: '#656d76', dark: '#8f8a84' }
// The hover tooltip's bubble and its text, and the enlarged square's outline:
// dark on a light page, light on a dark one.
const BUBBLE: Record<Theme, [string, string]> = { light: ['#1f2328', '#ffffff'], dark: ['#e6e3df', '#1b1a19'] }
const OUTLINE: Record<Theme, string> = { light: '#ffffff', dark: '#1b1a19' }

// Light by default and dark under the host's dark appearance. A square's
// hover card is hidden until its square is under the pointer; the
// interactive frame draws `:hover`, the editor's image never does.
const styleOf = (palette: Palette): string => {
  const colors = (theme: Theme) =>
    palette[theme].map((color, shade) => `.s${shade}{fill:${color}}`).join('') +
    `.label{fill:${LABEL[theme]}}#z{stroke:${OUTLINE[theme]}}` +
    `.grid g rect{fill:${BUBBLE[theme][0]}}.grid g text{fill:${BUBBLE[theme][1]}}`

  return (
    '<style>.label{font:10px system-ui,sans-serif}' +
    '.grid g{display:none;pointer-events:none}' +
    '.grid g text{font:600 11px system-ui,sans-serif;text-anchor:middle}' +
    '#z{stroke-width:2;filter:drop-shadow(0 1px 3px rgba(0,0,0,.35))}' +
    `${colors('light')}@media (prefers-color-scheme: dark){${colors('dark')}}</style>`
  )
}

// About how wide a run of 11px semibold system-ui text is.
const textWidth = (text: string): number => Math.ceil(text.length * 6.3)
const BUBBLE_HEIGHT = 22

// A square's hover card: the square drawn bigger and outlined, with a
// one-line bubble over it, or under it in the top rows, kept inside the
// drawing. Drawn after every square so none paints over it, and shown by a
// rule that matches its square under the pointer.
const cardOf = (day: Day, n: number, x: number, y: number, cell: number, width: number): string => {
  const text = tooltipOf(day)
  const big = Math.round(cell * GROW)
  const bigX = Math.round(x + cell / 2 - big / 2)
  const bigY = Math.round(y + cell / 2 - big / 2)
  const bubbleWidth = textWidth(text) + 16
  const left = Math.min(Math.max(0, Math.round(x + cell / 2 - bubbleWidth / 2)), width - bubbleWidth)
  const above = bigY - BUBBLE_HEIGHT - 4
  const top = above >= 0 ? above : bigY + big + 4

  return (
    `<g id="t${n}"><use href="#z" class="s${day.shade}" x="${bigX}" y="${bigY}"/>` +
    `<rect x="${left}" y="${top}" width="${bubbleWidth}" height="${BUBBLE_HEIGHT}" rx="5"/>` +
    `<text x="${Math.round(left + bubbleWidth / 2)}" y="${top + 15}">${text}</text></g>`
  )
}

const svgLabel = (x: number, y: number, text: string): string =>
  `<text class="label" x="${x}" y="${y}">${text}</text>`

// An SVG and the size it is drawn at: its own, so its squares stay the size
// of GitHub's however big the pane; a narrower pane shrinks it to fit. The
// height too, since the desktop's interactive frame, given none, is about
// 150px tall and shrinks a docked grid to fit it.
export type Picture = { source: string; width: number; height: number }

// The graphical surfaces' grid: one SVG of squares, each with its hover card
// under the pointer. Wider than the pane, the surface scales it down to fit.
export const svgOf = (graph: Graph, palette: Palette, layout: Layout): Picture => {
  const grid = gridOf(graph, layout)
  const { cell, pitch } = SIZES[layout]
  const width = LEFT + grid.across * pitch - (pitch - cell) + PAD[layout]
  const height = TOP + grid.down * pitch - (pitch - cell) + PAD[layout]
  const big = Math.round(cell * GROW)
  // A weekday's initial sits over the middle of its column, a month's name
  // on the middle of its row.
  const nudge = layout === 'vertical' ? cell / 2 - 3 : 0
  const baseline = Math.round(cell / 2 + 4)
  const labels = [
    ...grid.top.map(({ at, text }) => svgLabel(LEFT + at * pitch + nudge, TOP_BASELINE, text)),
    ...grid.side.map(({ at, text }) => svgLabel(0, TOP + at * pitch + baseline, text)),
  ]
  const squares = grid.squares.map(
    ({ day, x, y }, n) =>
      `<rect id="d${n}" class="s${day.shade}" x="${LEFT + x * pitch}" y="${TOP + y * pitch}" ` +
      `width="${cell}" height="${cell}" rx="${cell / 5}" data-day="${day.key}"/>`,
  )
  const cards = grid.squares.map(({ day, x, y }, n) =>
    cardOf(day, n, LEFT + x * pitch, TOP + y * pitch, cell, width),
  )
  // The cards follow every square in one group, so each square's rule finds
  // its card among its later siblings.
  const shown = grid.squares.map((_, n) => `#d${n}:hover~#t${n}`).join(',')

  return {
    source:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}">${styleOf(palette)}` +
      `<style>${shown}{display:inline}</style>` +
      `<defs><rect id="z" width="${big}" height="${big}" rx="${Math.round(big / 5)}"/></defs>` +
      labels.join('') +
      `<g class="grid">${squares.join('')}${cards.join('')}</g>` +
      '</svg>',
    width,
    height,
  }
}

// The graphical surfaces' legend: Less, the five shades, More, each word
// given room for itself.
const WORD = 24

export const legendSvgOf = (palette: Palette): Picture => {
  const squares = palette.light.map(
    (_, shade) =>
      `<rect class="s${shade}" x="${WORD + shade * PITCH}" y="0" width="${CELL}" height="${CELL}" rx="2"/>`,
  )
  const more = WORD + palette.light.length * PITCH + 1
  const width = more + WORD

  return {
    source:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${CELL}" ` +
      `viewBox="0 0 ${width} ${CELL}">${styleOf(palette)}` +
      svgLabel(0, ROW_BASELINE, 'Less') +
      squares.join('') +
      svgLabel(more, ROW_BASELINE, 'More') +
      '</svg>',
    width,
    height: CELL,
  }
}

// One square in a palette's strong shade, light and dark: what the palette
// button switches to, beside it where the button cannot take the color.
export const swatchSvgOf = (palette: Palette, shade: Shade): Picture => {
  const size = 12

  return {
    source:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
      `<style>rect{fill:${palette.light[shade]}}` +
      `@media (prefers-color-scheme: dark){rect{fill:${palette.dark[shade]}}}</style>` +
      `<rect width="${size}" height="${size}" rx="2"/></svg>`,
    width: size,
    height: size,
  }
}

const SQUARE = 0x25a0
const SPACE = 0x20
const TERMINAL_DEFAULT = 0x01000000

const rgb = (hex: string): number => Number.parseInt(hex.slice(1), 16)

export type Raster = { columns: number; rows: number; cells: string }

// The terminal's side labels: three letters and a gap.
export const SIDE_COLUMNS = 4

// The terminal's grid and its labels: one Raster, a square and a gap per
// column of the grid; the top
// labels as a line over it, the side labels one per row beside it. Too narrow
// for the side labels, they go first; too narrow for the gaps, the squares
// close up; too narrow still, the rightmost columns that fit are shown, which
// horizontally are the newest weeks.
export const terminalOf = (
  graph: Graph,
  palette: Palette,
  theme: Theme,
  bodyColumns: number,
  layout: Layout,
): { raster: Raster; top: string; side: string | undefined } => {
  const grid = gridOf(graph, layout)
  const hasSide = bodyColumns >= SIDE_COLUMNS + grid.across
  const room = hasSide ? bodyColumns - SIDE_COLUMNS : bodyColumns
  const step = grid.across * 2 - 1 <= room ? 2 : 1
  const shown = Math.min(grid.across, Math.max(1, room))
  const hidden = grid.across - shown
  const columns = shown * step - (step - 1)
  const rows = grid.down
  const words = new Uint32Array(columns * rows * 3)
  for (let at = 0; at < words.length; at += 3) {
    words[at] = SPACE
    words[at + 1] = TERMINAL_DEFAULT
    words[at + 2] = TERMINAL_DEFAULT
  }
  for (const { day, x, y } of grid.squares) {
    if (x < hidden) continue
    const at = (y * columns + (x - hidden) * step) * 3
    words[at] = SQUARE
    words[at + 1] = rgb(palette[theme][day.shade] ?? '#000000')
  }
  // A top label that would run into the one before it, or off the edge, is left out.
  const top = Array<string>(columns).fill(' ')
  let free = 0
  for (const { at, text } of grid.top) {
    const column = (at - hidden) * step
    if (at < hidden || column < free || column + text.length > columns) continue
    top.splice(column, text.length, ...text)
    free = column + text.length + 1
  }
  const side = Array.from(
    { length: rows },
    (_, row) => grid.side.find(label => label.at === row)?.text ?? '',
  )

  return {
    raster: { columns, rows, cells: new Uint8Array(words.buffer).toBase64() },
    top: top.join('').trimEnd(),
    side: hasSide ? side.join('\n') : undefined,
  }
}
