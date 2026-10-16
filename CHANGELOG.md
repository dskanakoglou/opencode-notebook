# Changelog

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
