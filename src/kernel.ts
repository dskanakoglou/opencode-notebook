// One Python kernel, kept alive by kernel/bridge.py and started through uv.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline"
import type { Output } from "./cells.ts"

const BRIDGE = fileURLToPath(new URL("../kernel/bridge.py", import.meta.url))
const BASE = ["jupyter_client", "ipykernel"]

export interface ExecResult {
  readonly status: "ok" | "error"
  readonly count: number | null
  readonly message?: string
}

export class Kernel {
  readonly cwd: string
  readonly dependencies: string[]
  python = ""
  private child?: ChildProcessWithoutNullStreams
  private ready?: Promise<void>
  private nextID = 1
  private pending = new Map<number, { onOutput: (o: Output) => void; resolve: (r: ExecResult) => void }>()
  private stderr = ""
  private exited = false

  constructor(cwd: string, dependencies: string[]) {
    this.cwd = cwd
    this.dependencies = [...dependencies].sort()
  }

  get alive() {
    return !!this.child && !this.exited
  }

  /** Starts the kernel; the first start downloads the packages, so allow a few minutes. */
  start(timeoutMs = 300_000): Promise<void> {
    if (this.ready) return this.ready
    const args = ["run", "-q", "--no-project", ...[...BASE, ...this.dependencies].flatMap((d) => ["--with", d]), "python", "-I", BRIDGE, this.cwd]
    const child = spawn("uv", args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONUNBUFFERED: "1" } })
    this.child = child
    child.stderr.on("data", (chunk) => (this.stderr = (this.stderr + chunk).slice(-4000)))
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`the kernel did not start within ${Math.round(timeoutMs / 1000)} s`))
        this.shutdown()
      }, timeoutMs)
      child.on("error", (error) => {
        clearTimeout(timer)
        reject(new Error(error.message.includes("ENOENT") ? "uv is not installed or not on PATH (https://docs.astral.sh/uv/)" : error.message))
      })
      child.on("exit", (code) => {
        this.exited = true
        clearTimeout(timer)
        const why = this.stderr.trim().split("\n").slice(-5).join("\n")
        reject(new Error(`the kernel exited (code ${code})${why ? `:\n${why}` : ""}`))
        for (const [, job] of this.pending) job.resolve({ status: "error", count: null, message: "the kernel stopped" })
        this.pending.clear()
      })
      createInterface({ input: child.stdout }).on("line", (line) => {
        let message: any
        try {
          message = JSON.parse(line)
        } catch {
          return
        }
        if (message.type === "ready") {
          this.python = message.python
          clearTimeout(timer)
          resolve()
        } else if (message.type === "fatal") {
          clearTimeout(timer)
          reject(new Error(message.message))
        } else if (message.type === "output") this.pending.get(message.id)?.onOutput(message.output)
        else if (message.type === "done") {
          const job = this.pending.get(message.id)
          this.pending.delete(message.id)
          job?.resolve({ status: message.status === "ok" ? "ok" : "error", count: message.count ?? null, message: message.message })
        }
      })
    })
    return this.ready
  }

  async exec(code: string, onOutput: (o: Output) => void): Promise<ExecResult> {
    await this.start()
    if (!this.alive) return { status: "error", count: null, message: "the kernel stopped" }
    const id = this.nextID++
    return new Promise<ExecResult>((resolve) => {
      this.pending.set(id, { onOutput, resolve })
      this.child!.stdin.write(JSON.stringify({ op: "exec", id, code }) + "\n")
    })
  }

  interrupt() {
    if (this.alive) this.child!.stdin.write(JSON.stringify({ op: "interrupt" }) + "\n")
  }

  shutdown() {
    if (!this.child || this.exited) return
    const child = this.child
    try {
      child.stdin.write(JSON.stringify({ op: "interrupt" }) + "\n")
      child.stdin.write(JSON.stringify({ op: "shutdown" }) + "\n")
      child.stdin.end()
    } catch {}
    // if it has not gone in a few seconds, stop it
    setTimeout(() => {
      if (!this.exited) child.kill()
    }, 5000).unref?.()
  }
}
