import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SYSTEM_PROMPT_ADDITION = `
## CodeGraph

This project has a CodeGraph index — a tree-sitter-parsed knowledge graph of every symbol, edge, and file. Reads are sub-millisecond and return structural information grep cannot.

### When to prefer codegraph over native search

Use codegraph for **structural** questions — what calls what, what would break, where is X defined, what is X's signature. Use native grep/read only for **literal text** queries (string contents, comments, log messages) or after you already have a specific file open.

| Question | Tool |
|---|---|
| "Where is X defined?" / "Find symbol named X" | \`codegraph_search\` |
| "What calls function Y?" | \`codegraph_callers\` |
| "What does Y call?" | \`codegraph_callees\` |
| "What would break if I changed Z?" | \`codegraph_impact\` |
| "Show me Y's signature / source / docstring" | \`codegraph_node\` |
| "Give me focused context for a task/area" | \`codegraph_context\` |
| "See several related symbols' source at once" | \`codegraph_explore\` |
| "What files exist under path/" | \`codegraph_files\` |
| "Is the index healthy?" | \`codegraph_status\` |

### Rules of thumb

- **Answer directly — don't delegate exploration.** For "how does X work" / architecture / trace questions, answer with 2-3 codegraph calls: \`codegraph_context\` first, then ONE \`codegraph_explore\` for the source of the symbols it surfaces. Codegraph IS the pre-built index, so a grep + read loop repeats work it already did and costs more for the same answer.
- **Trust codegraph results.** They come from a full AST parse. Do NOT re-verify them with grep.
- **Don't grep first** when looking up a symbol by name. \`codegraph_search\` is faster and returns kind + location + signature in one call.
- **Don't chain \`codegraph_search\` + \`codegraph_node\`** when you just want context — \`codegraph_context\` is one call.
- **Don't loop \`codegraph_node\` over many symbols** — one \`codegraph_explore\` call returns several symbols' source grouped in a single capped call.
- **Index lag**: the file watcher debounces ~500ms behind writes; don't re-query immediately after editing a file in the same turn.
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

function startMcpClient(cwd: string): Promise<McpClient> {
  return new Promise((resolveClient, rejectClient) => {
    const proc: ChildProcess = spawn("codegraph", ["serve", "--mcp"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let nextId = 1;
    const pending = new Map<number, Pending>();

    const rl = createInterface({ input: proc.stdout! });
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

    proc.on("error", rejectClient);

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
          destroy: () => proc.kill(),
        });
      })
      .catch(rejectClient);
  });
}

export default async function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  if (!existsSync(join(cwd, ".codegraph"))) return;

  let client: McpClient;
  try {
    client = await startMcpClient(cwd);
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
      } catch {}
    }
    client.destroy();
  });
}
