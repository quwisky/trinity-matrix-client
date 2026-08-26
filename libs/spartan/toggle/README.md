# toggle

This library was generated with [Nx](https://nx.dev).

Vendored as **toggle-group's dependency**, not for its own sake: `HlmToggleGroupItem` takes
its `toggleVariants` from here. Nothing in the app uses a standalone toggle, and there is no
`@trinity/components/toggle` wrapper — so feature code cannot reach it, and should not want
to. If a lone toggle button is ever needed, wrap it in the components tier first, the way
`@trinity/components/toggle-group` wraps its neighbour.
