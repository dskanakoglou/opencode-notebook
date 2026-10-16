import { test } from "node:test"
import assert from "node:assert/strict"
import { plotMode, terminalLine, terminalName } from "../src/terminal.ts"

test("names the terminal from its own answer first", () => {
  assert.equal(terminalName({ terminal: { name: "ghostty", version: "1.2.0" } }, { TERM_PROGRAM: "Apple_Terminal" }), "Ghostty 1.2.0")
})

test("falls back to the environment for terminals that do not answer", () => {
  assert.equal(terminalName({ terminal: { name: "" } }, { TERM_PROGRAM: "Apple_Terminal", TERM_PROGRAM_VERSION: "455" }), "macOS Terminal 455")
  assert.equal(terminalName(null, { TERM_PROGRAM: "vscode" }), "VS Code terminal")
  assert.equal(terminalName(null, { WT_SESSION: "x" }), "Windows Terminal")
  assert.equal(terminalName(null, { TERM: "xterm-256color" }), "unknown (xterm-256color)")
})

test("plots: Kitty first, Sixel only with a pixel size, never inside tmux", () => {
  assert.equal(plotMode({ kitty_graphics: true, sixel: true }, true), "kitty")
  assert.equal(plotMode({ sixel: true }, true), "sixel")
  assert.equal(plotMode({ sixel: true }, false), "file")
  assert.equal(plotMode({ kitty_graphics: true, multiplexer: "tmux" }, true), "file")
  assert.equal(plotMode(null, true), "file")
})

test("the panel line says the terminal and what happens to plots", () => {
  assert.equal(terminalLine({ multiplexer: "none" }, false, { TERM_PROGRAM: "Apple_Terminal", TERM_PROGRAM_VERSION: "455" }), "Terminal: macOS Terminal 455 · no image support, o opens plots")
  assert.equal(terminalLine({ kitty_graphics: true, terminal: { name: "WezTerm", version: "2024" } }, true, {}), "Terminal: WezTerm 2024 · plots drawn here (Kitty graphics)")
  assert.equal(terminalLine({ sixel: true, multiplexer: "tmux", terminal: { name: "iTerm2" } }, true, {}), "Terminal: iTerm2 in tmux · plots are not drawn inside tmux, o opens them")
})
