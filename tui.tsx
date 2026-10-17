/** @jsxImportSource @opentui/solid */
// TUI half: the notebook panel. It shows the cells and their outputs and runs
// cells on the kernel the server half owns, the same one the agent uses.
import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { createSignal, For, onCleanup, Show } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import type { Snapshot } from "./src/notebooks.ts"
import { NOTEBOOK_RPC } from "./src/rpc.ts"
import { textLines } from "./src/cells.ts"
import { ansiLines, type AnsiColor, type Segment } from "./src/ansi.ts"
import { plotMode, terminalLine, type Capabilities } from "./src/terminal.ts"

const PANEL = "notebook"
const ICON: Record<string, string> = { idle: " ", queued: "…", running: "◐", ok: "✓", error: "✗", cancelled: "-" }
const MAX_OUTPUT_LINES = 12
const MAX_CODE_LINES = 6
const PLOT_ROWS = 18
// mid-tone colours that read on dark and light themes; white, black and gray follow the theme
const ANSI: Partial<Record<AnsiColor, string>> = {
  red: "#e5534b",
  green: "#57ab5a",
  yellow: "#c69026",
  blue: "#539bf5",
  magenta: "#b083f0",
  cyan: "#39c5cf",
}

type Cell = Snapshot["cells"][number]

const plugin: Plugin.Definition = {
  id: "opencode-notebook",
  setup(ctx) {
    const rpc = ctx.client.rpc(NOTEBOOK_RPC)
    const where = () => (ctx.location ? { location: ctx.location } : undefined)
    const [path, setPath] = createSignal<string>()
    const [snap, setSnap] = createSignal<Snapshot>()
    const [selected, setSelected] = createSignal(1)
    const [error, setError] = createSignal<string>()

    const currentSession = () => {
      const route = ctx.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }
    const toast = (message: string, variant: "info" | "error" = "info") => ctx.ui.toast.show({ variant, message })

    const refresh = async (p = path()) => {
      if (!p) return
      try {
        setSnap((await rpc.snapshot({ path: p }, where())) as unknown as Snapshot)
        setError(undefined)
      } catch (e: any) {
        setError(e?.message ?? String(e))
      }
    }

    // follow the server: cell outputs, the agent's runs, kernel restarts
    const stop = rpc.events.on("changed", (event) => {
      if (ctx.location && event.location?.directory !== ctx.location.directory) return
      const p = event.data.path as string
      if (!path()) {
        setPath(p)
        if (!ctx.ui.panel.current()) toast(`Notebook ${p} is running: /notebook to watch`)
      }
      if (p === path()) void refresh(p)
    })
    onCleanup(stop)

    const open = async (input?: string) => {
      if (!currentSession()) return toast("Open a session first")
      let p = input?.trim() || path()
      if (!p) {
        const known = ((await rpc.list({}, where()).catch(() => ({ paths: [] }))) as { paths: string[] }).paths
        p = known.length === 1 ? known[0] : await ctx.ui.dialog.prompt({ title: "Open notebook", placeholder: "outputs/analysis.py" })
      }
      if (!p) return
      try {
        const s = (await rpc.open({ path: p }, where())) as unknown as Snapshot
        setPath(s.path)
        setSnap(s)
        setSelected(s.cells.find((c) => c.kind === "code")?.index ?? 1)
        ctx.ui.panel.open(PANEL)
      } catch (e: any) {
        toast(e?.message ?? String(e), "error")
      }
    }

    const act = (what: "run" | "interrupt" | "restart", cells?: number[]) => {
      const p = path()
      if (!p) return
      const call = what === "run" ? rpc.run({ path: p, cells }, where()) : rpc[what]({ path: p }, where())
      call.catch((e: any) => toast(e?.message ?? String(e), "error"))
    }
    // marked cells are what notebook_read gives the agent
    const markSelected = () => {
      const p = path()
      if (p) rpc.mark({ path: p, cell: selected() }, where()).catch((e: any) => toast(e?.message ?? String(e), "error"))
    }
    const move = (step: number) => {
      const cells = snap()?.cells ?? []
      if (!cells.length) return
      const at = Math.max(0, cells.findIndex((c) => c.index === selected()))
      setSelected(cells[Math.min(cells.length - 1, Math.max(0, at + step))].index)
    }
    const openPlot = () => {
      const cell = snap()?.cells.find((c) => c.index === selected())
      const plot = cell?.outputs.find((o) => o.kind === "image")?.path
      if (!plot) return toast("No plot in this cell")
      const file = resolve(ctx.location?.directory ?? process.cwd(), plot)
      const [cmd, args] = process.platform === "darwin" ? ["open", [file]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", file]] : ["xdg-open", [file]]
      spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => toast(`Could not open ${plot}`, "error")).unref()
    }

    ctx.ui.slot({
      append: "app",
      render() {
        ctx.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "notebook.open",
              title: "Notebook panel",
              description: "Open a notebook next to the chat",
              group: "Notebook",
              palette: true,
              slash: { name: "notebook", arguments: true },
              run: (input) => void open(input),
            },
          ],
        }))
        return null
      },
    })

    ctx.ui.slot({
      append: "session.panel",
      render: (input) => (
        <Show when={input.name === PANEL}>
          <NotebookPanel input={input} />
        </Show>
      ),
    })

    function NotebookPanel(props: { input: { focused: boolean; focus: () => void; width: number } }) {
      const theme = ctx.theme
      // what OpenTUI learned from the terminal at startup
      const caps = () => (ctx.renderer as any).capabilities as Capabilities | null
      const hasResolution = () => !!(ctx.renderer as any).resolution
      const pixels = () => plotMode(caps(), hasResolution()) !== "file"
      const plotWidth = () => Math.max(20, Math.min(props.input.width - 10, 90))
      const focused = () => props.input.focused
      let scroll: any
      ctx.keymap.layer(() => ({
        mode: "global",
        priority: 100,
        enabled: () => focused(),
        commands: [
          { title: "Previous cell", group: "Notebook", bind: "up", run: () => (move(-1), reveal()) },
          { title: "Next cell", group: "Notebook", bind: "down", run: () => (move(1), reveal()) },
          { title: "Run cell", group: "Notebook", bind: "r", run: () => act("run", [selected()]) },
          { title: "Run cell", group: "Notebook", bind: "return", run: () => (act("run", [selected()]), move(1), reveal()) },
          { title: "Run all", group: "Notebook", bind: "a", run: () => act("run") },
          { title: "Mark for the agent", group: "Notebook", bind: "space", run: markSelected },
          { title: "Interrupt", group: "Notebook", bind: "i", run: () => act("interrupt") },
          { title: "Restart kernel", group: "Notebook", bind: "k", run: () => act("restart") },
          { title: "Open plot", group: "Notebook", bind: "o", run: openPlot },
          { title: "Scroll up", group: "Notebook", bind: "pageup", run: () => page(-1) },
          { title: "Scroll down", group: "Notebook", bind: "pagedown", run: () => page(1) },
          { title: "Reload file", group: "Notebook", bind: "f5", run: () => void refresh() },
          { title: "Close notebook", group: "Notebook", bind: "escape", run: () => ctx.ui.panel.close() },
        ],
      }))
      // keys work straight away; ctrl+x ← goes back to the chat. OpenCode may hand
      // focus back to the prompt after the slash command, so ask again briefly.
      for (const ms of [0, 60, 200, 500]) setTimeout(() => !props.input.focused && props.input.focus(), ms)
      const page = (direction: number) => scroll?.scrollBy?.(direction * Math.max(5, (scroll?.height ?? 20) - 3))
      const reveal = () => setTimeout(() => scroll?.scrollChildIntoView?.(`nb-cell-${selected()}`))
      void refresh()

      const statusColor = (cell: Cell) =>
        cell.status === "error" ? theme.text.feedback.error.base : cell.stale ? theme.text.feedback.warning.base : cell.status === "ok" ? theme.text.base : theme.text.muted
      const kernelLine = () => {
        const k = snap()?.kernel
        if (!k) return ""
        const deps = k.dependencies.length ? ` · ${k.dependencies.join(", ")}` : ""
        return `kernel ${k.state}${k.python ? ` · Python ${k.python}` : ""}${deps}${k.message ? ` · ${k.message}` : ""}`
      }

      return (
        <box flexGrow={1} paddingLeft={1} paddingRight={1}>
          {/* flexShrink 0: a long notebook must shrink the cell list, not these lines */}
          <box flexShrink={0}>
            <text fg={theme.text.base}>
              <b>{`Notebook · ${path() ?? ""}`}</b>
            </text>
            <text fg={snap()?.kernel.state === "failed" ? theme.text.feedback.error.base : theme.text.muted}>{kernelLine()}</text>
            <text fg={theme.text.muted}>{terminalLine(caps(), hasResolution(), process.env)}</text>
            <Show when={error()}>
              <text fg={theme.text.feedback.error.base}>{error()}</text>
            </Show>
          </box>
          <scrollbox flexGrow={1} ref={(el: any) => (scroll = el)}>
            <For each={snap()?.cells ?? []}>
              {(cell) => (
                <box id={`nb-cell-${cell.index}`} paddingTop={1} onMouseUp={() => setSelected(cell.index)}>
                  <text
                    fg={cell.index === selected() ? (theme.text.action.primary.selected ?? theme.text.action.primary.base) : statusColor(cell)}
                    bg={cell.index === selected() ? theme.background.raised.high : undefined}
                  >
                    {`${cell.index === selected() ? "▸" : " "}${cell.marked ? "●" : " "}`}
                    {cell.kind === "markdown" ? <b>{`     ${cell.title ?? ""}`}</b> : `${`[${cell.count ?? " "}]`.padStart(4)} ${ICON[cell.status]} ${cell.label}`}
                    {cell.stale ? "  (edited since run)" : ""}
                  </text>
                  {/* text cells in full; code (the input) for every cell, all of it when selected.
                      The indent is padding, not spaces, so a wrapped line stays indented. */}
                  <Show when={cell.kind === "markdown"}>
                    <box paddingLeft={7} flexShrink={0}>
                      <For each={textLines(cell.source)}>{(line) => <text fg={theme.text.base}>{line}</text>}</For>
                    </box>
                  </Show>
                  <Show when={cell.kind === "code"}>
                    <box paddingLeft={7} flexShrink={0}>
                      <For each={codeLines(cell.source, cell.index === selected())}>{(line) => <text fg={theme.text.muted}>{`│ ${line}`}</text>}</For>
                    </box>
                  </Show>
                  <For each={cell.outputs}>
                    {(out) => (
                      <>
                        <box paddingLeft={7} flexShrink={0}>
                          <For each={clipSegments(out.kind === "image" && !pixels() ? `${out.text} · o opens it` : out.text, cell.index === selected())}>
                            {(line) => (
                              <text fg={out.kind === "error" ? theme.text.feedback.error.base : theme.text.base}>
                                <For each={line}>
                                  {(seg) => (
                                    <span
                                      style={{
                                        fg: seg.color === "gray" ? theme.text.muted : seg.color ? ANSI[seg.color] : undefined,
                                        bold: seg.bold,
                                        dim: seg.dim,
                                      }}
                                    >
                                      {seg.text.replace(/\u001b/g, "")}
                                    </span>
                                  )}
                                </For>
                              </text>
                            )}
                          </For>
                        </box>
                        {/* only where the terminal draws real pixels; coloured blocks are too coarse for a plot */}
                        <Show when={out.kind === "image" && out.path && pixels()}>
                          <box paddingLeft={7} flexShrink={0}>
                            <image source={resolve(ctx.location?.directory ?? process.cwd(), out.path!)} fit="fit" width={plotWidth()} height={PLOT_ROWS} protocol={plotMode(caps(), hasResolution()) === "kitty" ? "kitty" : "sixel"} />
                          </box>
                        </Show>
                      </>
                    )}
                  </For>
                </box>
              )}
            </For>
          </scrollbox>
          <box flexShrink={0}>
            <text fg={theme.text.muted}>
              {focused() ? "↑↓ cell · r run · a all · space mark · i stop · k restart · o plot · esc close" : "ctrl+x → to use the notebook keys"}
            </text>
            <text fg={theme.text.muted}>{[focused() ? "pgup/pgdn scroll · ctrl+x ← chat" : "", snap()?.ipynb ? `saved: ${snap()!.ipynb}` : ""].filter(Boolean).join(" · ")}</text>
          </box>
        </box>
      )
    }

    function codeLines(source: string, full: boolean): string[] {
      const lines = source.split("\n")
      if (full || lines.length <= MAX_CODE_LINES) return lines
      return [...lines.slice(0, MAX_CODE_LINES - 1), `… ${lines.length - MAX_CODE_LINES + 1} more lines`]
    }

    // the selected cell shows its whole output; the others their first lines
    /**
     * Output lines as coloured segments. Unless the cell is selected, a long
     * output shows its start and its end, where results usually are.
     */
    function clipSegments(text: string, full = false): Segment[][] {
      const lines = ansiLines(text)
      if (full || lines.length <= MAX_OUTPUT_LINES) return lines
      const head = Math.floor((MAX_OUTPUT_LINES - 1) / 3)
      const tail = MAX_OUTPUT_LINES - 1 - head
      return [
        ...lines.slice(0, head),
        [{ text: `… ${lines.length - head - tail} more lines (select the cell to see them all) …`, color: "gray" }],
        ...lines.slice(-tail),
      ]
    }
  },
}

export default plugin
