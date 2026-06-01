import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SYSTEM_PROMPT_ADDITION = `
## CodeGraph

This project has a CodeGraph index — a tree-sitter-parsed knowledge graph of every symbol, edge, and file. Reads return structural information grep cannot. Use Semble search to find the right symbol, then navigate with CodeGraph for relevant context.

## Semble Search

**Step 0 — locate the code symbol (skip only if you already know the exact name):**

\`semble search "concept or description" .\`

Semble bridges vocabulary mismatches (e.g. \`"tool call limit"\` → \`MAX_TOOL_ROUNDS\`). Get the symbol name + file, then proceed to step 1.

### Tool Choice

- Structural questions: use CodeGraph. This includes definitions, signatures, callers/callees, impact, architecture, data flow, request construction, persistence, resume/load behavior, and "what happens/current behavior" questions.
- Literal questions: use native search/read only for exact strings, comments, logs, config text, or a small range already identified by CodeGraph.
- Do not use native search/read, codegraph_explore, large owner symbols, or broad symbol searches for read-only structural/behavior answers.

### Micro-Budget

- For read-only structural/behavior questions, spend at most 2 CodeGraph calls by default:
  1. codegraph_context(includeCode:false, maxNodes:8) to find decisive symbols.
  2. One codegraph_node(includeCode:true) for the single decisive boundary, or codegraph_trace if the answer is specifically a path.
- If the first call already shows the decisive type/signature/relationship, answer immediately without a second call.
- Use a third CodeGraph call only if the first two results conflict or the user explicitly asks for more proof.
- If uncertainty remains after the budget, state it as a caveat instead of investigating adjacent plumbing.

### Boundaries

- Prefer decisive boundary symbols over plumbing: public types/schemas, save-load functions, request builders, command/route handlers, adapters.
- Do not inspect parser helpers, option/message types, UI previews, store internals, callbacks, or owner components/classes unless the decisive boundary explicitly delegates there.
- Do not prove negatives by exhaustive search. If the boundary lacks a field/path, answer from that and mention the caveat.
- Avoid duplicate source retrieval. Never fetch source for the same symbol twice.
- Use codegraph_explore only during implementation work when several exact small symbols are needed.
- Do not run git diff / git status for read-only code questions.
`;

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface McpClient {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  destroy(): void;
}

const clientsByCwd = new Map<string, McpClient>();

let cleanupHooked = false;

// codegraph spawns a 3-process tree (node launcher -> node -> native binary) that does NOT
// self-terminate on stdin EOF, so the OS will not reap it when pi dies abruptly. The
// session_shutdown handler covers graceful exits; this backstop covers process.exit() and
// terminal-driven signals. SIGINT is intentionally excluded: pi uses it to cancel the current
// agent turn, not to exit, so hooking it would force-kill pi on the first Ctrl-C.
function ensureProcessCleanup() {
  if (cleanupHooked) return;
  cleanupHooked = true;
  const killAll = () => {
    for (const client of clientsByCwd.values()) client.destroy();
  };
  process.once("exit", killAll);
  for (const sig of ["SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      killAll();
      process.kill(process.pid, sig);
    });
  }
}

function rejectPending(pending: Map<number, Pending>, error: Error) {
  for (const p of pending.values()) {
    p.reject(error);
  }
  pending.clear();
}

// Recursively collect descendant PIDs of rootPid by walking the ps ppid table. Synchronous so
// it can run inside a process "exit" handler. Returns [] on any failure (best-effort cleanup).
function descendantPids(rootPid: number): number[] {
  try {
    const out = execSync("ps -axo pid=,ppid=", { encoding: "utf8" });
    const children = new Map<number, number[]>();
    for (const line of out.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const siblings = children.get(ppid);
      if (siblings) siblings.push(pid);
      else children.set(ppid, [pid]);
    }
    const descendants: number[] = [];
    const stack = [rootPid];
    while (stack.length) {
      const parent = stack.pop()!;
      for (const child of children.get(parent) ?? []) {
        descendants.push(child);
        stack.push(child);
      }
    }
    return descendants;
  } catch {
    return [];
  }
}

// The native codegraph worker can setsid into its own process group, escaping a group-kill of
// the launcher. So we snapshot the descendant PIDs BEFORE signaling, then signal both the
// launcher's group (cheap, reaps in-group processes) and every descendant by direct PID (reaches
// the escaped worker regardless of its group).
function killProcessTree(proc: ChildProcess) {
  const { pid } = proc;
  if (!pid) {
    proc.kill("SIGTERM");
    return;
  }

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  const targets = descendantPids(pid);
  try {
    process.kill(-pid, "SIGTERM");
  } catch { }
  for (const target of [...targets, pid]) {
    try {
      process.kill(target, "SIGTERM");
    } catch { }
  }
}

function startMcpClient(cwd: string): Promise<McpClient> {
  return new Promise((resolveClient, rejectClient) => {
    const proc: ChildProcess = spawn("codegraph", ["serve", "--mcp"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    let nextId = 1;
    const pending = new Map<number, Pending>();
    let settled = false;
    let destroyed = false;

    const rl: Interface = createInterface({ input: proc.stdout! });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: { id?: number; result?: unknown; error?: { message: string } };
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      // Ignore notifications (no id)
      if (msg.id === undefined) return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      rejectPending(pending, new Error("codegraph MCP client destroyed"));
      rl.close();
      proc.stdin?.end();
      killProcessTree(proc);
    }

    function failStartup(error: Error) {
      if (settled) return;
      settled = true;
      destroy();
      rejectClient(error);
    }

    proc.once("error", failStartup);
    proc.once("exit", (code, signal) => {
      const error = new Error(
        `codegraph MCP exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`
      );
      rejectPending(pending, error);
      if (!settled) {
        settled = true;
        rejectClient(error);
      }
    });

    function rpc<T>(method: string, params?: unknown): Promise<T> {
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(id, {
          resolve: res as (v: unknown) => void,
          reject: rej,
        });
        proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    }

    function notify(method: string, params?: unknown) {
      proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    }

    rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pi-codegraph", version: "1.0.0" },
    })
      .then(() => {
        if (destroyed) return;
        settled = true;
        notify("notifications/initialized");
        resolveClient({
          listTools: () =>
            rpc<{ tools: McpTool[] }>("tools/list").then((r) => r.tools),
          callTool: (name, args) =>
            rpc<{ content: Array<{ type: string; text?: string }> }>("tools/call", {
              name,
              arguments: args,
            }).then((r) =>
              r.content
                .filter((c) => c.type === "text")
                .map((c) => c.text ?? "")
                .join("\n")
            ),
          destroy,
        });
      })
      .catch((error) => failStartup(error instanceof Error ? error : new Error(String(error))));
  });
}

export default async function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  if (!existsSync(join(cwd, ".codegraph"))) return;

  clientsByCwd.get(cwd)?.destroy();
  clientsByCwd.delete(cwd);

  let client: McpClient;
  try {
    client = await startMcpClient(cwd);
    clientsByCwd.set(cwd, client);
    ensureProcessCleanup();
  } catch {
    return;
  }

  let tools: McpTool[];
  try {
    tools = await client.listTools();
  } catch {
    client.destroy();
    return;
  }

  for (const tool of tools) {
    const toolName = tool.name;
    pi.registerTool({
      name: toolName,
      label: toolName.replace("codegraph_", "").replace(/_/g, " "),
      description: tool.description,
      parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
      execute: async (_id, params) => {
        try {
          const text = await client.callTool(toolName, params as Record<string, unknown>);
          return { content: [{ type: "text" as const, text }], details: {} };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `codegraph error: ${message}` }],
            details: {},
          };
        }
      },
    });
  }

  // Inject the codegraph section into the base system prompt so it is present from session
  // startup, not just on the first agent turn. The factory runs inside resourceLoader.reload()
  // before discoverAppendSystemPromptFile() is called, so writing here is picked up in the
  // same reload pass and lands in _baseSystemPrompt via appendSystemPrompt (works with both
  // custom and default system prompts, unlike promptGuidelines which is skipped for customPrompt).
  const piDir = join(cwd, ".pi");
  const appendFile = join(piDir, "APPEND_SYSTEM.md");
  let wroteAppendFile = false;
  if (!existsSync(appendFile)) {
    try {
      mkdirSync(piDir, { recursive: true });
      writeFileSync(appendFile, SYSTEM_PROMPT_ADDITION, "utf-8");
      wroteAppendFile = true;
    } catch {
      // Fall through to before_agent_start fallback below
    }
  }

  if (!wroteAppendFile) {
    // Fallback for when .pi/APPEND_SYSTEM.md already exists (user-owned file).
    pi.on("before_agent_start", (event) => {
      return { systemPrompt: event.systemPrompt + SYSTEM_PROMPT_ADDITION };
    });
  }

  pi.on("session_shutdown", () => {
    if (wroteAppendFile) {
      try {
        unlinkSync(appendFile);
      } catch { }
    }
    client.destroy();
    clientsByCwd.delete(cwd);
  });
}
