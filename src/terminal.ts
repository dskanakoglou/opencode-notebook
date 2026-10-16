// What the panel says about the terminal: its name, and how it will show plots.
// OpenTUI asks the terminal at startup (XTVERSION, device attributes, a Kitty
// graphics query); terminals that do not answer are named from the environment.

export interface Capabilities {
  kitty_graphics?: boolean
  sixel?: boolean
  multiplexer?: string
  terminal?: { name?: string; version?: string }
}

const NAMES: Record<string, string> = {
  apple_terminal: "macOS Terminal",
  vscode: "VS Code terminal",
  "iterm.app": "iTerm2",
  iterm2: "iTerm2",
  wezterm: "WezTerm",
  ghostty: "Ghostty",
  kitty: "kitty",
  "xterm-kitty": "kitty",
  warpterminal: "Warp",
  alacritty: "Alacritty",
  windowsterminal: "Windows Terminal",
  tmux: "tmux",
}

function pretty(name: string): string {
  return NAMES[name.toLowerCase()] ?? name
}

/** The terminal's name and version, from its own answer or else the environment. */
export function terminalName(caps: Capabilities | null | undefined, env: Record<string, string | undefined>): string {
  const reported = caps?.terminal?.name?.trim()
  if (reported) return [pretty(reported), caps?.terminal?.version?.trim()].filter(Boolean).join(" ")
  if (env.TERM_PROGRAM) return [pretty(env.TERM_PROGRAM), env.TERM_PROGRAM_VERSION].filter(Boolean).join(" ")
  if (env.WT_SESSION) return "Windows Terminal"
  if (env.TERM === "xterm-kitty") return "kitty"
  return env.TERM ? `unknown (${env.TERM})` : "unknown"
}

export type PlotMode = "kitty" | "sixel" | "file"

/** How plots can be shown: real pixels (Kitty or Sixel graphics) or only as files. */
export function plotMode(caps: Capabilities | null | undefined, hasResolution: boolean): PlotMode {
  if (!caps || caps.multiplexer === "tmux") return "file"
  if (caps.kitty_graphics) return "kitty"
  if (caps.sixel && hasResolution) return "sixel"
  return "file"
}

/** One line for the top of the panel. */
export function terminalLine(caps: Capabilities | null | undefined, hasResolution: boolean, env: Record<string, string | undefined>): string {
  const inside = caps?.multiplexer && caps.multiplexer !== "none" && caps.multiplexer !== "unknown" ? ` in ${caps.multiplexer}` : ""
  const mode = plotMode(caps, hasResolution)
  const plots =
    mode === "kitty" ? "plots drawn here (Kitty graphics)"
    : mode === "sixel" ? "plots drawn here (Sixel graphics)"
    : caps?.multiplexer === "tmux" ? "plots are not drawn inside tmux, o opens them"
    : "no image support, o opens plots"
  return `Terminal: ${terminalName(caps, env)}${inside} · ${plots}`
}
