# Changelog

## 0.1.7

- The key hints at the foot of the panel sit on a band one step above the
  panel background, with the keys in the accent colour.
- The hints say what each key does: `enter run, next · r run · a run all ·
  space show to agent` on the first line, moving and the rest on the second.
  `i stop` appears only while a cell runs, and `o open plot` only when the
  selected cell has a plot.

## 0.1.6

- The arrow keys, Enter and mouse clicks select only cells that can run;
  text cells are passed over. A notebook of text alone still moves through it.
- A text cell without a title shows only its text, with no empty line above it.

## 0.1.5

- `/notebook` is described as "Open a notebook next to the chat" in the command
  list, and opening a file that is not a `.py` file says so in plain words.

## 0.1.4

- Outputs show terminal colours and bold (ANSI codes), so a notebook can make
  its question and answer stand out; Python errors keep their colours too. The
  agent's `notebook_read` still gets plain text.
- A long output shows its start and its end until the cell is selected, so
  the result at the bottom stays in view.

## 0.1.3

- Text cells wrap to the panel's width: the lines of a paragraph are joined,
  as Markdown does, and a wrapped line keeps its indent. Code and output lines
  keep their indent when they wrap, too.
- A text cell's title is shown in bold, without the `md` label.

## 0.1.2

- Text cells (`# %% [markdown]`) are shown in full in the panel, so a
  notebook can explain itself step by step.
- Every code cell shows its code above its output: the first lines, or all of
  it when selected.

## 0.1.1

- The selected cell shows its whole output; the others still show their
  first lines. Outputs up to 20,000 characters reach the panel (was 4,000).
- `pgup` / `pgdn` scroll the panel, for long outputs.

## 0.1.0

First release.

- **Notebook panel** beside the chat (`/notebook <path>`): cells with run numbers,
  state and outputs; run a cell (`r`), run all (`a`), stop (`i`), restart the
  kernel (`k`), open a plot (`o`); `ctrl+x ←/→` moves between chat and panel.
- **One live kernel per notebook**, shared by you and the agent, started through
  uv with the packages from the notebook's `# /// script` block.
- **`notebook_run`** for the agent, limited to the `roots` folders (default
  `outputs/`), and **`notebook_read`**, which reads the cells you mark with
  `space` or the ones named, with their latest outputs.
- Notebooks are `.py` files with `# %%` cells; every run saves `<name>.ipynb`
  and the plots as PNG files.
- The panel names your terminal and whether it can draw plots inline (Kitty or
  Sixel graphics).
