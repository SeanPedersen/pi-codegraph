import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SYSTEM_PROMPT_ADDITION = `
## CodeGraph

This project has a CodeGraph index — a tree-sitter-parsed knowledge graph of every symbol, edge, and file. Reads return structural information grep cannot.

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
      } catch { }
    }
    client.destroy();
  });
}
