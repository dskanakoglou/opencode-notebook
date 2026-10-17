import { test } from "node:test"
import assert from "node:assert/strict"
import { ansiLines } from "../src/ansi.ts"

const E = "\u001b["

test("plain text is one segment per line", () => {
  assert.deepEqual(ansiLines("a\nb"), [[{ text: "a" }], [{ text: "b" }]])
})

test("colours, bold and reset", () => {
  assert.deepEqual(ansiLines(`${E}1;33mQuestion:${E}0m plain ${E}32manswer${E}39m.`), [
    [
      { text: "Question:", bold: true, color: "yellow" },
      { text: " plain " },
      { text: "answer", color: "green" },
      { text: "." },
    ],
  ])
})

test("a colour carries on to the next line until reset", () => {
  assert.deepEqual(ansiLines(`${E}90mgrey\nstill grey${E}0m\nplain`), [
    [{ text: "grey", color: "gray" }],
    [{ text: "still grey", color: "gray" }],
    [{ text: "plain" }],
  ])
})

test("other codes are dropped, not shown", () => {
  assert.deepEqual(ansiLines(`${E}2K${E}38;5;208mx${E}m`), [[{ text: "x" }]])
})
