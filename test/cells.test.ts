import { test } from "node:test"
import assert from "node:assert/strict"
import { cellLabel, clip, outputText, overview, parseDependencies, parseNotebook, readReport, report, sourceHash, textLines, toIpynb } from "../src/cells.ts"

const SCRIPT = `# /// script
# dependencies = [
#   "pandas>=2",
#   'matplotlib',
# ]
# ///

# %% Load
import pandas as pd
df = pd.read_csv("x.csv")

# %% [markdown]
# ## Missing values
# Counts per column.

# %%
df.isna().sum()
`

test("splits # %% cells and keeps titles and markdown", () => {
  const nb = parseNotebook(SCRIPT)
  assert.deepEqual(
    nb.cells.map((c) => [c.index, c.kind, c.title, c.line]),
    [
      [1, "code", "Load", 8],
      [2, "markdown", "", 12],
      [3, "code", "", 16],
    ],
  )
  assert.equal(nb.cells[0].source, 'import pandas as pd\ndf = pd.read_csv("x.csv")')
  assert.equal(nb.cells[1].source, "## Missing values\nCounts per column.")
  assert.equal(cellLabel(nb.cells[2]), "df.isna().sum()")
})

test("reads PEP 723 dependencies, single or multi-line", () => {
  assert.deepEqual(parseDependencies(SCRIPT), ["pandas>=2", "matplotlib"])
  assert.deepEqual(parseDependencies('# /// script\n# dependencies = ["numpy"]\n# ///\n'), ["numpy"])
  assert.deepEqual(parseDependencies("import os\n"), [])
})

test("code before the first marker is a cell; comments alone are not", () => {
  assert.equal(parseNotebook("# just a header\n\n# %%\nx = 1\n").cells.length, 1)
  const nb = parseNotebook("import os\n# %%\nx = 1\n")
  assert.deepEqual(nb.cells.map((c) => c.source), ["import os", "x = 1"])
  assert.deepEqual(parseNotebook("print(1)\n").cells.map((c) => c.source), ["print(1)"])
})

test("source hash changes with the code", () => {
  assert.equal(sourceHash("a = 1"), sourceHash("a = 1"))
  assert.notEqual(sourceHash("a = 1"), sourceHash("a = 2"))
})

test("error output keeps the last frames, without colour codes", () => {
  const text = outputText({
    output_type: "error",
    ename: "ZeroDivisionError",
    evalue: "division by zero",
    traceback: ["\u001b[31m---------\u001b[0m", "Cell In[3], line 1", "----> 1 1/0", "\u001b[31mZeroDivisionError\u001b[39m: division by zero"],
  })
  assert.ok(text.endsWith("ZeroDivisionError: division by zero"))
  assert.ok(!text.includes("\u001b"))
})

test("error output points at the notebook line, not library frames", () => {
  const text = outputText({
    output_type: "error",
    ename: "KeyError",
    evalue: "'nope'",
    traceback: [
      "\u001b[31m---------------------------------------------------------------------------\u001b[39m",
      "\u001b[31mKeyError\u001b[39m                                  Traceback (most recent call last)",
      "Cell In[4], line 1\n----> 1 df[\"nope\"]",
      "File /x/pandas/core/frame.py:4113, in DataFrame.__getitem__(self, key)\n   4111 if is_integer(key):\n-> 4113 indexer = self.columns.get_loc(key)",
      "\u001b[31mKeyError\u001b[39m: 'nope'",
    ],
  })
  assert.equal(text, 'Cell In[4], line 1\n----> 1 df["nope"]\nKeyError: \'nope\'')
})

test("a plot is reported by its saved path", () => {
  assert.equal(outputText({ output_type: "display_data", data: { "text/plain": "<Figure>", "image/png": "iVBOR" } }, "outputs/a_files/cell-3-1.png"), "[plot saved: outputs/a_files/cell-3-1.png]")
})

test("clip keeps the start and the end", () => {
  const long = "a".repeat(100) + "END"
  const out = clip(long, 50)
  assert.ok(out.startsWith("aaa") && out.endsWith("END") && out.includes("characters cut"))
  assert.equal(clip("short", 50), "short")
})

test("report caps each cell and the total", () => {
  const nb = parseNotebook(SCRIPT)
  const text = report(
    "outputs/a.py",
    [
      { cell: nb.cells[0], status: "ok", outputs: [{ output_type: "stream", name: "stdout", text: "x".repeat(5000) }], images: {} },
      { cell: nb.cells[2], status: "error", outputs: [{ output_type: "error", ename: "KeyError", evalue: "'y'", traceback: ["KeyError: 'y'"] }], images: {} },
    ],
    { perCell: 200, total: 2000 },
  )
  assert.ok(text.startsWith("outputs/a.py: ran 2 cells, 1 ok, 1 failed."))
  assert.ok(text.includes("[1] ok · Load"))
  assert.ok(text.includes("[3] error\nKeyError: 'y'"))
  assert.ok(text.length < 2100)
})

test("ipynb is nbformat 4.5 with ids, outputs and our marker", () => {
  const nb = parseNotebook(SCRIPT)
  const json = JSON.parse(toIpynb(nb, new Map([[1, { outputs: [{ output_type: "stream", name: "stdout", text: "hi\n" }], count: 1 }]])))
  assert.equal(json.nbformat, 4)
  assert.equal(json.nbformat_minor, 5)
  assert.deepEqual(json.cells.map((c: any) => c.id), ["cell-1", "cell-2", "cell-3"])
  assert.equal(json.cells[0].execution_count, 1)
  assert.equal(json.cells[0].source.join(""), nb.cells[0].source)
  assert.equal(json.cells[1].cell_type, "markdown")
  assert.ok(json.metadata.opencode_notebook.generated)
})

test("read report gives code and output, and says when the code changed", () => {
  const nb = parseNotebook(SCRIPT)
  const text = readReport(
    "outputs/a.py",
    [
      { cell: nb.cells[1], status: "idle", stale: false, outputs: [], images: {} },
      { cell: nb.cells[2], status: "ok", stale: true, outputs: [{ output_type: "execute_result", data: { "text/plain": "sex    11" } }], images: {} },
    ],
    { note: "marked by the user" },
  )
  assert.ok(text.startsWith("outputs/a.py: 2 cells (marked by the user)."))
  assert.ok(text.includes("[2] markdown\n## Missing values"))
  assert.ok(text.includes("[3] ok · edited since it ran\ndf.isna().sum()\n--- output:\nsex    11"))
})

test("overview lists cells without outputs and explains marking", () => {
  const nb = parseNotebook(SCRIPT)
  const text = overview("outputs/a.py", nb.cells.map((cell) => ({ cell, status: cell.index === 1 ? "ok" : "idle" })))
  assert.ok(text.includes("None are marked"))
  assert.ok(text.includes("[1] ok · Load"))
  assert.ok(text.includes("[3] not run · df.isna().sum()"))
})

test("text cells: paragraph lines are joined, everything else keeps its line", () => {
  const source = ["First line of a", "paragraph.", "", "- a list item", "  that goes on", "- another", "", "## Heading", "| a | b |", "```", "code stays", "as is", "```", "Last."].join("\n")
  assert.deepEqual(textLines(source), [
    "First line of a paragraph.",
    "",
    "- a list item that goes on",
    "- another",
    "",
    "## Heading",
    "| a | b |",
    "```",
    "code stays",
    "as is",
    "```",
    "Last.",
  ])
})
