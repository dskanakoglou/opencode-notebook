// Pure functions: reading `# %%` notebooks, summarising outputs, writing .ipynb.
// No OpenCode or Node APIs here, so everything is unit-tested.

export type CellKind = "code" | "markdown"

export interface Cell {
  /** 1-based, as shown in the panel and used by the agent. */
  readonly index: number
  readonly kind: CellKind
  readonly title: string
  readonly source: string
  /** First line of the cell in the file, 1-based. */
  readonly line: number
}

export interface Notebook {
  readonly cells: Cell[]
  /** Packages from the `# /// script` block (PEP 723), for the kernel. */
  readonly dependencies: string[]
}

/** One nbformat v4 output, as the kernel bridge sends it. */
export type Output =
  | { output_type: "stream"; name: string; text: string }
  | { output_type: "execute_result" | "display_data"; data: Record<string, unknown>; metadata?: Record<string, unknown>; execution_count?: number }
  | { output_type: "error"; ename: string; evalue: string; traceback: string[] }

const MARKER = /^# ?%%(.*)$/
const SCRIPT_START = /^# \/\/\/ script\s*$/
const SCRIPT_END = /^# \/\/\/\s*$/

/**
 * A text cell's lines for the panel. Lines of one paragraph are joined, as
 * Markdown does, so the panel wraps them to its width instead of breaking
 * each source line on its own. Headings, list items, tables, quotes, code and
 * blank lines keep their own lines.
 */
export function textLines(source: string): string[] {
  const out: string[] = []
  let fence = false
  let open = false // the last line is a paragraph or list item that a plain line continues
  for (const line of source.split("\n")) {
    const t = line.trim()
    if (/^(```|~~~)/.test(t)) {
      fence = !fence
      out.push(line)
      open = false
    } else if (fence || t === "" || /^(#|\||>)/.test(t) || /^ {4}/.test(line)) {
      out.push(line)
      open = false
    } else if (/^([-*+]|\d+[.)])\s/.test(t)) {
      out.push(line)
      open = true
    } else if (open) {
      out[out.length - 1] += ` ${t}`
    } else {
      out.push(line)
      open = true
    }
  }
  return out
}

/** Packages listed under `dependencies` in a PEP 723 `# /// script` block. */
export function parseDependencies(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => SCRIPT_START.test(l))
  if (start < 0) return []
  const end = lines.findIndex((l, i) => i > start && SCRIPT_END.test(l))
  if (end < 0) return []
  const toml = lines
    .slice(start + 1, end)
    .map((l) => l.replace(/^# ?/, ""))
    .join("\n")
  const match = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(toml)
  if (!match) return []
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1].trim()).filter(Boolean)
}

/**
 * Splits a percent-format script into cells: every `# %%` line starts one, and
 * `# %% [markdown]` starts a markdown cell. Text before the first marker is a
 * cell too, unless it is only comments, blank lines and the `# /// script` block.
 */
export function parseNotebook(text: string): Notebook {
  const lines = text.split(/\r?\n/)
  const cells: Cell[] = []
  let current: { kind: CellKind; title: string; line: number; body: string[] } | undefined
  let preamble: string[] = []
  let inScript = false

  const flush = () => {
    if (!current) return
    const body = trimBlank(current.body)
    const source = current.kind === "markdown" ? body.map((l) => l.replace(/^# ?/, "")).join("\n") : body.join("\n")
    cells.push({ index: cells.length + 1, kind: current.kind, title: current.title, source, line: current.line })
  }

  lines.forEach((line, i) => {
    const marker = MARKER.exec(line)
    if (marker) {
      if (!current) {
        const code = trimBlank(preamble)
        if (code.some((l) => l.trim() && !l.trimStart().startsWith("#")))
          cells.push({ index: 1, kind: "code", title: "", source: code.join("\n"), line: 1 })
      }
      flush()
      const rest = marker[1].trim()
      const kind: CellKind = /\[markdown\]|\[md\]/i.test(rest) ? "markdown" : "code"
      const title = rest.replace(/\[(markdown|md)\]/i, "").trim()
      current = { kind, title, line: i + 1, body: [] }
      return
    }
    if (current) {
      current.body.push(line)
      return
    }
    // before the first marker: drop the script block, keep the rest
    if (SCRIPT_START.test(line)) inScript = true
    else if (inScript && SCRIPT_END.test(line)) inScript = false
    else if (!inScript) preamble.push(line)
  })
  if (current) flush()
  else {
    const code = trimBlank(preamble)
    if (code.some((l) => l.trim())) cells.push({ index: 1, kind: "code", title: "", source: code.join("\n"), line: 1 })
  }
  return { cells, dependencies: parseDependencies(text) }
}

function trimBlank(lines: string[]): string[] {
  let a = 0
  let b = lines.length
  while (a < b && !lines[a].trim()) a++
  while (b > a && !lines[b - 1].trim()) b--
  return lines.slice(a, b)
}

/** A short label for a cell: its title, or its first line of code. */
export function cellLabel(cell: Cell): string {
  if (cell.title) return cell.title
  const first = cell.source.split("\n").find((l) => l.trim()) ?? ""
  return first.trim() || "(empty)"
}

/** A stable fingerprint of a cell's source, to notice edits since it last ran. */
export function sourceHash(source: string): string {
  let h = 2166136261
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
}

function asText(value: unknown): string {
  if (Array.isArray(value)) return value.join("")
  return typeof value === "string" ? value : ""
}

/** Text for one output: printed text, the plain-text result, or the error. `image` names a saved plot. */
export function outputText(output: Output, image?: string): string {
  switch (output.output_type) {
    case "stream":
      return stripAnsi(output.text)
    case "error": {
      const trace = output.traceback.map(stripAnsi).join("\n").split("\n").filter((l) => l.trim() && !/^-{5,}/.test(l.trim()))
      const last = `${output.ename}: ${output.evalue}`.replace(/: $/, ":")
      // the line in the notebook that failed, then the error; library frames are in the .ipynb
      const start = trace.findIndex((l) => /^Cell In\[\d*\]/.test(l))
      if (start < 0) return last
      const frame: string[] = [trace[start]]
      for (const l of trace.slice(start + 1)) {
        if (/^(File |Cell In\[)/.test(l) || l === trace.at(-1)) break
        frame.push(l)
      }
      return [...frame.slice(0, 5), last].join("\n")
    }
    default: {
      if (image) return `[plot saved: ${image}]`
      return asText(output.data["text/plain"])
    }
  }
}

/** Shortens text to `max` characters, keeping the start and the end. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  const tail = max - head
  return `${text.slice(0, head)}\n… (${text.length - max} characters cut) …\n${text.slice(-tail)}`
}

export interface RanCell {
  readonly cell: Cell
  readonly status: "ok" | "error" | "cancelled"
  readonly outputs: Output[]
  /** Saved plot paths, by output position. */
  readonly images: Record<number, string>
}

/** The report the agent gets back: per cell its status and capped outputs. */
export function report(path: string, ran: RanCell[], options: { perCell?: number; total?: number } = {}): string {
  const perCell = options.perCell ?? 1500
  const total = options.total ?? 6000
  const ok = ran.filter((r) => r.status === "ok").length
  const failed = ran.filter((r) => r.status === "error").length
  const parts = [`${path}: ran ${ran.length} cell${ran.length === 1 ? "" : "s"}, ${ok} ok, ${failed} failed.`]
  for (const r of ran) {
    const head = `[${r.cell.index}] ${r.status}${r.cell.title ? ` · ${r.cell.title}` : ""}`
    const body = r.outputs.map((o, i) => outputText(o, r.images[i])).filter((t) => t.trim()).join("\n")
    parts.push(body ? `${head}\n${clip(body.trimEnd(), perCell)}` : head)
  }
  return clip(parts.join("\n\n"), total)
}

export interface ReadCell {
  readonly cell: Cell
  readonly status: string
  /** The code changed after the outputs were made. */
  readonly stale: boolean
  readonly outputs: Output[]
  readonly images: Record<number, string>
}

/** What `notebook_read` returns: each cell's code and latest outputs, capped like `report`. */
export function readReport(path: string, cells: ReadCell[], options: { perCell?: number; total?: number; note?: string } = {}): string {
  const perCell = options.perCell ?? 1500
  const total = options.total ?? 6000
  const parts = [`${path}: ${cells.length} cell${cells.length === 1 ? "" : "s"}${options.note ? ` (${options.note})` : ""}.`]
  for (const r of cells) {
    const status = r.cell.kind === "markdown" ? "markdown" : r.status === "idle" ? "not run" : r.status
    const head = `[${r.cell.index}] ${status}${r.cell.title ? ` · ${r.cell.title}` : ""}${r.stale ? " · edited since it ran" : ""}`
    const body = r.outputs.map((o, i) => outputText(o, r.images[i])).filter((t) => t.trim()).join("\n")
    const code = clip(r.cell.source, perCell)
    parts.push(body ? `${head}\n${code}\n--- output:\n${clip(body.trimEnd(), perCell)}` : `${head}\n${code}`)
  }
  return clip(parts.join("\n\n"), total)
}

/** Just the list of cells, for when nothing is marked. */
export function overview(path: string, cells: { cell: Cell; status: string }[]): string {
  const lines = cells.map(({ cell, status }) => `[${cell.index}] ${cell.kind === "markdown" ? "markdown" : status === "idle" ? "not run" : status} · ${cellLabel(cell)}`)
  return [`${path}: ${cells.length} cells. None are marked; the user marks cells with space in the notebook panel, or name cells to read.`, ...lines].join("\n")
}

/** nbformat v4 JSON for the notebook with its latest outputs. */
export function toIpynb(notebook: Notebook, results: Map<number, { outputs: Output[]; count?: number | null }>): string {
  const split = (s: string) => s.split(/(?<=\n)/)
  const cells = notebook.cells.map((cell) => {
    const id = `cell-${cell.index}`
    if (cell.kind === "markdown") return { id, cell_type: "markdown", metadata: {}, source: split(cell.source) }
    const result = results.get(cell.index)
    return {
      id,
      cell_type: "code",
      execution_count: result?.count ?? null,
      metadata: {},
      outputs: result?.outputs ?? [],
      source: split(cell.source),
    }
  })
  return (
    JSON.stringify(
      {
        cells,
        metadata: {
          kernelspec: { display_name: "Python 3 (ipykernel)", language: "python", name: "python3" },
          language_info: { name: "python" },
          opencode_notebook: { generated: true },
        },
        nbformat: 4,
        nbformat_minor: 5,
      },
      null,
      1,
    ) + "\n"
  )
}
