// The calls between the panel (TUI) and the server half, which owns the kernels.
const object = { type: "object" } as const
const path = { type: "object", properties: { path: { type: "string" } }, required: ["path"] } as const

export const NOTEBOOK_RPC = {
  id: "opencode-notebook",
  methods: {
    open: { input: path, output: object },
    snapshot: { input: path, output: object },
    run: {
      input: { type: "object", properties: { path: { type: "string" }, cells: { type: "array", items: { type: "integer" } } }, required: ["path"] },
      output: object,
    },
    interrupt: { input: path, output: object },
    restart: { input: path, output: object },
    list: { input: object, output: object },
    mark: { input: { type: "object", properties: { path: { type: "string" }, cell: { type: "integer" } }, required: ["path", "cell"] }, output: object },
  },
  events: {
    changed: { schema: { type: "object", properties: { path: { type: "string" }, by: { type: "string" } }, required: ["path"] } },
  },
} as const
