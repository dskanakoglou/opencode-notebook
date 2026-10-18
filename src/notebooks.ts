// The open notebooks of one project: their cells, kernels and latest outputs.
// Lives in the server half, so the agent's tool and the panel share one kernel.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Kernel } from "./kernel.ts"
import {
  cellLabel,
  clip,
  outputText,
  overview,
  parseNotebook,
  readReport,
  sourceHash,
  toIpynb,
  type Cell,
  type Notebook,
  type Output,
  type RanCell,
  type ReadCell,
} from "./cells.ts"

export type CellStatus = "idle" | "queued" | "running" | "ok" | "error" | "cancelled"
export type KernelState = "off" | "starting" | "idle" | "busy" | "failed"

interface Result {
  hash: string
  status: CellStatus
  outputs: Output[]
  images: Record<number, string>
  count: number | null
}

interface Entry {
  rel: string
  abs: string
  notebook: Notebook
  mtime: number
  kernel?: Kernel
  kernelState: KernelState
  kernelMessage?: string
  results: Map<number, Result>
  queue: Promise<unknown>
  generation: number
  ipynb?: string
  /** Cells the user marked in the panel for the agent to read. */
  marked: Set<number>
  /** When a cell last ran or was queued, for stopping kernels nobody uses. */
  lastUsed: number
}

/** What the panel shows; plain JSON so it can cross RPC. */
export interface Snapshot {
  path: string
  ipynb?: string
  kernel: { state: KernelState; python?: string; message?: string; dependencies: string[] }
  cells: {
    index: number
    kind: "code" | "markdown"
    title: string
    label: string
    source: string
    status: CellStatus
    count: number | null
    stale: boolean
    marked: boolean
    outputs: { kind: "text" | "error" | "image"; text: string; path?: string }[]
  }[]
}

export class PathError extends Error {}

/** A kernel nobody has used for this long is stopped (OpenCode's server can outlive the chat window). */
export const IDLE_MS = 60 * 60_000

export class Notebooks {
  readonly root: string
  private readonly changed: (path: string) => void
  private entries = new Map<string, Entry>()
  private readonly idleMs: number
  private readonly sweeper: ReturnType<typeof setInterval>

  constructor(root: string, changed: (path: string) => void, idleMs = IDLE_MS) {
    this.root = root
    this.changed = changed
    this.idleMs = idleMs
    // check every minute; unref, so the timer alone never keeps OpenCode running
    this.sweeper = setInterval(() => this.sweep(), 60_000)
    this.sweeper.unref?.()
  }

  /**
   * Stops kernels that are not working: unused for `idleMs`, or whose notebook file is
   * gone. Outputs stay; the next run starts a fresh kernel, as after a restart.
   */
  sweep(now = Date.now()) {
    for (const e of this.entries.values()) {
      if (!e.kernel || e.kernelState === "busy" || e.kernelState === "starting") continue
      if ([...e.results.values()].some((r) => r.status === "queued" || r.status === "running")) continue
      const gone = !existsSync(e.abs)
      if (!gone && now - e.lastUsed < this.idleMs) continue
      e.kernel.shutdown()
      e.kernel = undefined
      e.kernelState = "off"
      e.kernelMessage = gone
        ? "stopped: the notebook file is gone"
        : `stopped after ${Math.round(this.idleMs / 60_000)} min without use; run the cells again from the top`
      this.changed(e.rel)
    }
  }

  /** Resolves a project-relative or absolute path; it must be a .py file inside the project. */
  resolvePath(path: string, roots?: string[]): { abs: string; rel: string } {
    const abs = resolve(this.root, path)
    const rel = relative(this.root, abs)
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new PathError(`${path} is outside the project`)
    if (extname(abs) !== ".py") throw new PathError(`${path} is not a notebook: a notebook is a .py file`)
    if (roots?.length && !roots.some((r) => rel === r || rel.startsWith(r.replace(/\/+$/, "") + sep)))
      throw new PathError(`notebooks can only be run under ${roots.join(", ")}; ${rel} is not`)
    return { abs, rel: rel.split(sep).join("/") }
  }

  /** Reads the file again if it changed, and returns its entry. */
  load(path: string, roots?: string[]): Entry {
    const { abs, rel } = this.resolvePath(path, roots)
    if (!existsSync(abs)) throw new PathError(`${rel} does not exist`)
    const mtime = statSync(abs).mtimeMs
    let entry = this.entries.get(rel)
    if (!entry) {
      entry = { rel, abs, notebook: parseNotebook(readFileSync(abs, "utf8")), mtime, kernelState: "off", results: new Map(), queue: Promise.resolve(), generation: 0, marked: new Set(), lastUsed: Date.now() }
      this.entries.set(rel, entry)
    } else if (entry.mtime !== mtime) {
      entry.notebook = parseNotebook(readFileSync(abs, "utf8"))
      entry.mtime = mtime
    }
    return entry
  }

  list(): string[] {
    return [...this.entries.keys()]
  }

  /** Marks or unmarks a cell for `notebook_read`. */
  mark(path: string, index: number) {
    const e = this.load(path)
    if (e.marked.has(index)) e.marked.delete(index)
    else if (e.notebook.cells.some((c) => c.index === index)) e.marked.add(index)
    this.changed(e.rel)
  }

  /**
   * The notebook `notebook_read` means when the agent gives no path: the one with
   * marked cells, or the only one open.
   */
  defaultPath(): string {
    const all = [...this.entries.values()]
    const marked = all.filter((e) => e.marked.size)
    if (marked.length === 1) return marked[0].rel
    if (all.length === 1) return all[0].rel
    if (!all.length) throw new PathError("no notebook is open; give the path of the .py notebook")
    throw new PathError(`several notebooks are open (${all.map((e) => e.rel).join(", ")}); give the path`)
  }

  /**
   * Text for the agent: the named cells, else the marked ones, each with its code
   * and latest outputs (whoever ran them). With neither, only the list of cells.
   */
  read(path: string, cells?: number[]): string {
    const e = this.load(path)
    const wanted = cells?.length ? cells : [...e.marked].sort((a, b) => a - b)
    if (!wanted.length) return overview(e.rel, e.notebook.cells.map((cell) => ({ cell, status: e.results.get(cell.index)?.status ?? "idle" })))
    const missing = wanted.filter((i) => !e.notebook.cells.some((c) => c.index === i))
    if (missing.length) throw new PathError(`no cell ${missing.join(", ")} in ${e.rel} (it has ${e.notebook.cells.length})`)
    const items: ReadCell[] = e.notebook.cells
      .filter((c) => wanted.includes(c.index))
      .map((cell) => {
        const r = e.results.get(cell.index)
        return { cell, status: r?.status ?? "idle", stale: this.stale(r, cell), outputs: r?.outputs ?? [], images: r?.images ?? {} }
      })
    return readReport(e.rel, items, { note: cells?.length ? undefined : "marked by the user" })
  }

  private stale(r: Result | undefined, cell: Cell): boolean {
    return !!r && r.hash !== sourceHash(cell.source) && r.status !== "queued" && r.status !== "running"
  }

  snapshot(path: string): Snapshot {
    const e = this.load(path)
    return {
      path: e.rel,
      ipynb: e.ipynb,
      kernel: { state: e.kernelState, python: e.kernel?.python || undefined, message: e.kernelMessage, dependencies: e.notebook.dependencies },
      cells: e.notebook.cells.map((cell) => {
        const r = e.results.get(cell.index)
        return {
          index: cell.index,
          kind: cell.kind,
          title: cell.title,
          label: cellLabel(cell),
          source: cell.source,
          status: r?.status ?? "idle",
          count: r?.count ?? null,
          stale: this.stale(r, cell),
          marked: e.marked.has(cell.index),
          outputs: (r?.outputs ?? []).map((o, i) => ({
            kind: o.output_type === "error" ? ("error" as const) : r!.images[i] ? ("image" as const) : ("text" as const),
            text: clip(outputText(o, r!.images[i], true).replace(/\n+$/, ""), 20000),
            path: r!.images[i],
          })),
        }
      }),
    }
  }

  /**
   * Runs cells in order on the notebook's kernel; `cells` are 1-based indices, all code cells when empty.
   * Calls queue up behind each other, so the agent and the panel never run cells at the same time.
   */
  run(path: string, cells?: number[], roots?: string[]): Promise<RanCell[]> {
    const e = this.load(path, roots)
    const wanted = this.pick(e, cells)
    const generation = e.generation
    e.lastUsed = Date.now()
    for (const cell of wanted) this.set(e, cell, { status: "queued" })
    this.changed(e.rel)
    const job = e.queue.then(() => this.runCells(e, wanted, generation))
    e.queue = job.catch(() => {})
    return job
  }

  private pick(e: Entry, cells?: number[]): Cell[] {
    const code = e.notebook.cells.filter((c) => c.kind === "code")
    if (!cells?.length) return code
    const missing = cells.filter((i) => !code.some((c) => c.index === i))
    if (missing.length) throw new PathError(`no code cell ${missing.join(", ")} in ${e.rel} (code cells: ${code.map((c) => c.index).join(", ") || "none"})`)
    return code.filter((c) => cells.includes(c.index))
  }

  private async runCells(e: Entry, wanted: Cell[], generation: number): Promise<RanCell[]> {
    // the file may have changed while this call waited in the queue
    const fresh = this.load(e.rel)
    const ran: RanCell[] = []
    for (const old of wanted) {
      const cell = fresh.notebook.cells.find((c) => c.index === old.index) ?? old
      if (e.generation !== generation) {
        this.set(e, cell, { status: "cancelled" })
        ran.push({ cell, status: "cancelled", outputs: [], images: {} })
        continue
      }
      const kernel = await this.kernel(e).catch((error: Error) => error)
      if (kernel instanceof Error) {
        const outputs: Output[] = [{ output_type: "error", ename: "KernelError", evalue: kernel.message, traceback: [kernel.message] }]
        this.set(e, cell, { status: "error", outputs })
        ran.push({ cell, status: "error", outputs, images: {} })
        e.generation++ // the remaining cells cannot run either
        generation = -1
        continue
      }
      const result: Result = { hash: sourceHash(cell.source), status: "running", outputs: [], images: {}, count: null }
      e.results.set(cell.index, result)
      e.kernelState = "busy"
      this.changed(e.rel)
      const done = await kernel.exec(cell.source, (output) => {
        const n = result.outputs.length
        result.outputs.push(output)
        const image = this.saveImage(e, cell, n, output)
        if (image) result.images[n] = image
        this.changed(e.rel)
      })
      if (done.message && !result.outputs.some((o) => o.output_type === "error"))
        result.outputs.push({ output_type: "error", ename: "KernelError", evalue: done.message, traceback: [done.message] })
      result.status = done.status
      result.count = done.count
      e.kernelState = kernel.alive ? "idle" : "failed"
      e.lastUsed = Date.now()
      ran.push({ cell, status: done.status, outputs: result.outputs, images: result.images })
      this.writeIpynb(e)
      this.changed(e.rel)
      // like Jupyter's "run all": stop at the first error
      if (done.status === "error") {
        e.generation++
        generation = -1
      }
    }
    return ran
  }

  /** The running kernel, restarted when the notebook's packages changed. */
  private async kernel(e: Entry): Promise<Kernel> {
    const deps = [...e.notebook.dependencies].sort().join(" ")
    if (e.kernel && (!e.kernel.alive || e.kernel.dependencies.join(" ") !== deps)) {
      e.kernel.shutdown()
      e.kernel = undefined
    }
    if (!e.kernel) {
      e.kernel = new Kernel(this.root, e.notebook.dependencies)
      e.kernelState = "starting"
      e.kernelMessage = e.notebook.dependencies.length ? `installing ${e.notebook.dependencies.join(", ")}` : undefined
      this.changed(e.rel)
      try {
        await e.kernel.start()
        e.kernelState = "idle"
        e.kernelMessage = undefined
      } catch (error) {
        e.kernelState = "failed"
        e.kernelMessage = (error as Error).message
        e.kernel = undefined
        this.changed(e.rel)
        throw error
      }
    }
    return e.kernel
  }

  /** Stops the running cell and cancels the queued ones. */
  interrupt(path: string) {
    const e = this.load(path)
    e.generation++
    for (const r of e.results.values()) if (r.status === "queued") r.status = "cancelled"
    e.kernel?.interrupt()
    this.changed(e.rel)
  }

  /** A fresh kernel: all variables are gone, outputs stay until cells run again. */
  restart(path: string) {
    const e = this.load(path)
    e.generation++
    e.kernel?.shutdown()
    e.kernel = undefined
    e.kernelState = "off"
    for (const r of e.results.values()) if (r.status === "queued" || r.status === "running") r.status = "cancelled"
    this.changed(e.rel)
  }

  dispose() {
    clearInterval(this.sweeper)
    for (const e of this.entries.values()) e.kernel?.shutdown()
    this.entries.clear()
  }

  private set(e: Entry, cell: Cell, patch: Partial<Result>) {
    const prev = e.results.get(cell.index)
    e.results.set(cell.index, {
      hash: prev?.hash ?? sourceHash(cell.source),
      outputs: prev?.outputs ?? [],
      images: prev?.images ?? {},
      count: prev?.count ?? null,
      status: "idle",
      ...prev,
      ...patch,
    })
  }

  private stem(e: Entry) {
    return join(dirname(e.abs), basename(e.abs, ".py"))
  }

  private saveImage(e: Entry, cell: Cell, n: number, output: Output): string | undefined {
    if (output.output_type !== "display_data" && output.output_type !== "execute_result") return
    const png = output.data["image/png"]
    if (typeof png !== "string") return
    const dir = `${this.stem(e)}_files`
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `cell-${cell.index}-${n + 1}.png`)
    writeFileSync(file, Buffer.from(png, "base64"))
    return relative(this.root, file).split(sep).join("/")
  }

  /** Saves `<name>.ipynb` next to the .py, never over a notebook this plugin did not write. */
  private writeIpynb(e: Entry) {
    let file = `${this.stem(e)}.ipynb`
    if (existsSync(file) && !ours(file)) file = `${this.stem(e)}.opencode.ipynb`
    const results = new Map([...e.results].map(([i, r]) => [i, { outputs: r.outputs, count: r.count }]))
    try {
      writeFileSync(file, toIpynb(e.notebook, results))
      e.ipynb = relative(this.root, file).split(sep).join("/")
    } catch {}
  }
}

function ours(file: string): boolean {
  try {
    return !!JSON.parse(readFileSync(file, "utf8"))?.metadata?.opencode_notebook
  } catch {
    return false
  }
}
