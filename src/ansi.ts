// Pure functions: terminal colour codes (ANSI SGR) in cell outputs, turned into
// coloured pieces of text for the panel. The agent gets the text without them.

export type AnsiColor = "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white" | "gray"

export interface Segment {
  readonly text: string
  readonly color?: AnsiColor
  readonly bold?: boolean
  readonly dim?: boolean
}

interface Style {
  color?: AnsiColor
  bold?: boolean
  dim?: boolean
}

const COLORS: AnsiColor[] = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]
// any CSI sequence; only SGR (ending in m) changes the style, the rest is dropped
const CSI = /\u001b\[([0-9;]*)([A-Za-z])/g

function apply(style: Style, params: string): Style {
  const codes = params === "" ? [0] : params.split(";").map((p) => Number(p) || 0)
  const next = { ...style }
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]
    if (c === 0) {
      delete next.color
      delete next.bold
      delete next.dim
    } else if (c === 1) next.bold = true
    else if (c === 2) next.dim = true
    else if (c === 22) {
      delete next.bold
      delete next.dim
    } else if (c >= 30 && c <= 37) next.color = COLORS[c - 30]
    else if (c === 39) delete next.color
    else if (c === 90) next.color = "gray"
    else if (c >= 91 && c <= 97) next.color = COLORS[c - 90]
    else if (c === 38 || c === 48) i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0 // 256-colour and RGB: skipped
  }
  return next
}

/**
 * Splits text with colour codes into lines of segments. A colour that is not
 * reset at the end of a line carries on into the next, as in a terminal.
 */
export function ansiLines(text: string): Segment[][] {
  let style: Style = {}
  return text.split("\n").map((line) => {
    const segments: Segment[] = []
    let last = 0
    for (const m of line.matchAll(CSI)) {
      if (m.index! > last) segments.push({ text: line.slice(last, m.index), ...style })
      if (m[2] === "m") style = apply(style, m[1])
      last = m.index! + m[0].length
    }
    if (last < line.length) segments.push({ text: line.slice(last), ...style })
    return segments
  })
}
