# pi-codegraph

A [pi coding agent](https://github.com/earendil-works/pi) extension that wires [codegraph](https://github.com/SeanPedersen/codegraph) as an MCP sidecar and injects structured usage instructions into the system prompt.

## What it does

When a project has a `.codegraph/` index, this extension:

1. Spawns `codegraph serve --mcp` as a sidecar process
2. Registers all codegraph tools (`codegraph_search`, `codegraph_callers`, `codegraph_callees`, `codegraph_impact`, `codegraph_node`, `codegraph_context`, `codegraph_explore`, `codegraph_files`, `codegraph_status`) directly in the session
3. Injects a `## CodeGraph` section into the base system prompt via `APPEND_SYSTEM.md` so the instructions are present from session startup — not just on the first agent turn

If the project has no `.codegraph/` directory the extension is a no-op.

## Requirements

- [`codegraph`](https://github.com/SeanPedersen/codegraph) CLI must be on `$PATH`
- A `.codegraph/` index must exist in the project root (run `codegraph init -i` to build one)

## Install

### As a pi package

```
/add pi-codegraph
```

### Manual (git)

```
/add https://github.com/SeanPedersen/pi-codegraph
```

## Building the index

```bash
codegraph init -i        # initial index build
```

The file watcher keeps the index current while pi is running.
