import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Notebooks } from "../src/notebooks.ts"

// a stand-in for a running kernel: records whether it was stopped
function fakeKernel() {
  return { alive: true, stopped: false, shutdown() { this.stopped = true } }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nb-idle-"))
  writeFileSync(join(root, "a.py"), "# %% One\nx = 1\n")
  const changed: string[] = []
  const notebooks = new Notebooks(root, (p) => changed.push(p), 60_000)
  const e: any = notebooks.load("a.py")
  e.kernel = fakeKernel()
  e.kernelState = "idle"
  return { root, notebooks, e, changed }
}

test("a kernel in use stays; an unused one is stopped, with the reason shown", () => {
  const { root, notebooks, e, changed } = setup()
  const kernel = e.kernel
  notebooks.sweep(e.lastUsed + 30_000)
  assert.equal(kernel.stopped, false)
  notebooks.sweep(e.lastUsed + 61_000)
  assert.equal(kernel.stopped, true)
  assert.equal(e.kernelState, "off")
  assert.match(e.kernelMessage, /stopped after 1 min without use/)
  assert.deepEqual(changed, ["a.py"])
  notebooks.dispose()
  rmSync(root, { recursive: true })
})

test("a busy kernel is never stopped, however long it runs", () => {
  const { root, notebooks, e } = setup()
  e.kernelState = "busy"
  notebooks.sweep(e.lastUsed + 10 * 60_000)
  assert.equal(e.kernel.stopped, false)
  notebooks.dispose()
  rmSync(root, { recursive: true })
})

test("a kernel whose notebook file is gone is stopped at once", () => {
  const { root, notebooks, e } = setup()
  const kernel = e.kernel
  rmSync(join(root, "a.py"))
  notebooks.sweep(e.lastUsed + 1_000)
  assert.equal(kernel.stopped, true)
  assert.match(e.kernelMessage, /file is gone/)
  notebooks.dispose()
  rmSync(root, { recursive: true })
})
