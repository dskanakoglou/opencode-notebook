// Server half: owns the kernels, gives the agent `notebook_run`, and answers the panel.
// Plugin tools run without OpenCode's approval prompt, so the tool only runs
// notebooks under the folders in `roots` (default: outputs/). Deny it with
// {"action": "notebook_run", "resource": "*", "effect": "deny"}.
import type { Plugin } from "@opencode/plugin"
import { report } from "./src/cells.ts"
import { Notebooks, PathError } from "./src/notebooks.ts"
import { NOTEBOOK_RPC } from "./src/rpc.ts"

export const TOOL = "notebook_run"
export const READ_TOOL = "notebook_read"

type PathInput = { path: string; cells?: number[] }
// OpenCode validates input against the JSON schema, so only the type is narrowed here
const asPath = (input: unknown) => input as PathInput
// RPC replies must be plain JSON: no `undefined` fields
const json = (value: unknown) => JSON.parse(JSON.stringify(value))

const plugin: Plugin.Plugin = {
  id: "opencode-notebook",
  async setup(ctx) {
    const roots: string[] = Array.isArray(ctx.options?.roots) ? ctx.options.roots : ["outputs"]
    let emit: ((path: string) => void) | undefined
    const pendingEmits = new Map<string, ReturnType<typeof setTimeout>>()
    // outputs can arrive many times a second; the panel only needs a few updates
    const changed = (path: string) => {
      if (pendingEmits.has(path)) return
      pendingEmits.set(
        path,
        setTimeout(() => {
          pendingEmits.delete(path)
          emit?.(path)
        }, 100),
      )
    }
    const notebooks = new Notebooks(ctx.location.directory, changed)

    const rpc = await ctx.rpc.register(NOTEBOOK_RPC, {
      open: async (input) => json(notebooks.snapshot(asPath(input).path)),
      snapshot: async (input) => json(notebooks.snapshot(asPath(input).path)),
      run: async (input) => {
        const { path, cells } = asPath(input)
        // the panel does not wait for the cells; it follows the `changed` events
        notebooks.run(path, cells).catch(() => {})
        return { started: true }
      },
      interrupt: async (input) => (notebooks.interrupt(asPath(input).path), { ok: true }),
      restart: async (input) => (notebooks.restart(asPath(input).path), { ok: true }),
      list: async () => ({ paths: notebooks.list() }),
      mark: async (input) => {
        const { path, cell } = input as { path: string; cell: number }
        notebooks.mark(path, cell)
        return { ok: true }
      },
    })
    emit = (path) => void rpc.events.emit("changed", { path }).catch(() => {})

    const tool = await ctx.tool.transform((editor) => {
      editor.add({
        name: TOOL,
        // kept short: it is sent with every request, and workshop models have 16k windows
        description: `Run cells of a Python notebook: a .py file under ${roots.join(", ")}/ whose cells start with "# %%". The kernel stays alive between calls (like Jupyter) and the user sees it in the notebook panel. List packages in a "# /// script" block with dependencies = [...]. Omit cells to run all; stops at the first error.`,
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Project-relative path of the .py notebook" },
            cells: { type: "array", items: { type: "integer" }, description: "1-based cell numbers; omit for all" },
          },
          required: ["path"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (raw, context) => {
          const input = asPath(raw)
          const onAbort = () => {
            try {
              notebooks.interrupt(input.path)
            } catch {}
          }
          context.signal.addEventListener("abort", onAbort)
          try {
            const ran = await notebooks.run(input.path, input.cells, roots)
            const snap = notebooks.snapshot(input.path)
            const text = report(snap.path, ran) + (snap.ipynb ? `\n\nSaved with outputs: ${snap.ipynb}` : "")
            return { content: text, metadata: { path: snap.path, ipynb: snap.ipynb, cells: ran.map((r) => ({ index: r.cell.index, status: r.status })) } }
          } catch (error) {
            if (error instanceof PathError) return { content: `Not run: ${error.message}` }
            throw error
          } finally {
            context.signal.removeEventListener("abort", onAbort)
          }
        },
      })
    })

    const reader = await ctx.tool.transform((editor) => {
      editor.add({
        name: READ_TOOL,
        description: `Read cells of the user's notebook with their latest outputs, including cells the user ran. Without cells: the cells the user marked in the notebook panel. Use it when the user asks about their notebook or the cells they marked.`,
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "The .py notebook; omit for the one the user has open" },
            cells: { type: "array", items: { type: "integer" }, description: "1-based cell numbers; omit for the marked cells" },
          },
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (raw) => {
          const input = raw as { path?: string; cells?: number[] }
          try {
            return { content: notebooks.read(input.path || notebooks.defaultPath(), input.cells) }
          } catch (error) {
            if (error instanceof PathError) return { content: `Not read: ${error.message}` }
            throw error
          }
        },
      })
    })

    return () => {
      reader.dispose()
      tool.dispose()
      rpc.dispose()
      notebooks.dispose()
    }
  },
}

export default plugin
