# pi-codegraph — architecture notes

A [pi coding agent](https://github.com/earendil-works/pi) extension that wires the
[`codegraph`](https://colbymchenry.github.io/codegraph/) CLI in as an MCP sidecar and injects
usage instructions into the system prompt. See `README.md` for user-facing install/usage.

The entire extension is a single file: `extensions/codegraph.ts`.

## Lifecycle overview

The default export is the extension factory. On each invocation it:

1. No-ops if `cwd/.codegraph/` is absent (the project has no index).
2. Tears down any prior client registered for the same `cwd` (reload safety), then spawns
   `codegraph serve --mcp` via `startMcpClient` and registers it in `clientsByCwd`.
3. Lists the sidecar's tools and registers each one with pi (`codegraph_*`).
4. Writes the `## CodeGraph` guidance to `.pi/APPEND_SYSTEM.md` so it lands in the base system
   prompt from session startup. If that file already exists (user-owned), it falls back to a
   `before_agent_start` hook instead. The written file is removed on `session_shutdown`.

## Process-management decisions

The non-obvious part of this extension is reliably killing the sidecar. The decisions below
were validated empirically (see commit history / PR discussion), not assumed.

### `codegraph serve --mcp` is a 3-process tree

`codegraph` is a Node launcher that spawns another node, which spawns the platform-specific
native binary (`@colbymchenry/codegraph-<platform>`). Observed tree:

```
codegraph (node launcher)   <- the process we spawn
└─ node
   └─ native binary         <- the actual server
```

Consequence: a plain `proc.kill()` signals only the direct child (the launcher) and **orphans
the native binary grandchild**. We must kill the whole tree.

### The tree does NOT self-terminate on stdin EOF

A mid-session stdin EOF is ignored (only a startup-time EOF, before `initialize`, causes the
server to exit). So we cannot rely on the OS closing the stdin pipe to clean up when pi dies —
explicit killing is always required.

### The native worker escapes the launcher's process group (group-kill is NOT sufficient)

Observed in practice: an orphaned native-binary process with its **own** `pgid` (equal to its own
pid), parent reparented to 1. The worker `setsid`s into its own process group/session, so a
group-kill of the launcher (`process.kill(-launcherPid)`) reaps the launcher and the middle node
but **misses the escaped worker**, leaving it orphaned. This behavior is variable — sometimes the
worker stays in the launcher's group — so group-kill alone cannot be relied on.

### Therefore: snapshot descendant PIDs, then group-kill AND direct-PID kill

The child is still spawned with `detached: true` on non-Windows (the launcher becomes a group
leader, making the group-kill a cheap first pass). `killProcessTree` then:

1. Snapshots all descendant PIDs of the launcher via `descendantPids()` (a synchronous `ps` ppid
   walk) **before** signaling anything — while the worker is still linked by ppid to a live
   parent, so it is captured even after it has `setsid`'d.
2. Sends `SIGTERM` to the launcher's group (`process.kill(-pid)`) — reaps in-group processes.
3. Sends `SIGTERM` to every snapshotted PID **directly** — reaches the escaped worker regardless
   of its process group.

Windows still uses `taskkill /T /F`, which already walks the tree by PID.

The snapshot must happen before any kill: once the launcher dies, descendants reparent to PID 1
and the ppid links break. Caveat: if the launcher subtree is already partially dead when
`killProcessTree` runs (rare), descendants that reparented before the snapshot won't be found.

Trade-off on `detached`: it removes the automatic terminal-driven cleanup (a child in pi's own
process group would receive the terminal's Ctrl-C for free). Reverting it was rejected because
(a) plain `proc.kill()` orphans the grandchildren on every clean `/exit`, and (b) the worker
`setsid`s out of the terminal's foreground group on its own anyway, so terminal-driven cleanup
would not reach it regardless. Explicit PID-based killing is required either way.

### `ensureProcessCleanup` backstop

Registered once (module scope) after the first successful client start. It kills all registered
clients on:

- `process.once("exit")` — covers `process.exit()` / event-loop drain.
- `SIGTERM` / `SIGHUP` — external kill request / terminal closed; cleans up then re-raises the
  default (the `once` handler removes itself first, so there is no loop).

**`SIGINT` is intentionally NOT hooked.** In pi, Ctrl-C cancels the current agent turn rather
than exiting the process; hooking `SIGINT` here would force-kill pi on the first Ctrl-C and break
that UX. `SIGKILL` is unhandleable by design and accepted as an unavoidable orphan case.

### Startup/teardown invariants in `startMcpClient`

- `settled` guards the client promise against double resolve/reject across the `error`, `exit`,
  and `initialize` paths.
- `destroyed` makes `destroy()` idempotent and prevents resolving a client torn down mid-init.
- On any teardown, in-flight RPCs are rejected via `rejectPending` so callers don't hang.

## Conventions

- Single-file extension; keep it that way unless it grows materially. Top-of-file module
  docstring should stay accurate.
- TypeScript / Node 22, pnpm, volta (per global tooling defaults).
- No build step is configured; the file is consumed by pi directly.
