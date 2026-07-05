// broker(server, options) — the single entry point.
//
// It rebinds the server's tool-registration methods so every tool registered
// AFTER this call runs inside the enforcement pipeline, with no change to the
// handler the author writes. Register tools before calling broker() and they
// are left ungoverned, so the rule is: wrap once, first.
//
// The handler receives its usual (args, ctx) with ctx.credential injected: the
// resolved, narrow secret for this call only. A blocked call returns an MCP
// tool error result; it never reaches the handler.
import { runPipeline, type PipelineDeps } from "./pipeline.js";
import { defaultIdentityResolver } from "./identity.js";
import { resolvePolicySource, resolveSecretSource, resolveAuditSink } from "./sources.js";
import type { BrokerOptions, Credential, McpHandlerExtra } from "./types.js";

// Structural view of the high-level MCP server, so the broker does not hard-bind
// to the SDK's exact class (the SDK is a peer dependency the author provides).
export interface WrappableServer {
  tool: (...args: unknown[]) => unknown;
  registerTool: (...args: unknown[]) => unknown;
  server?: unknown;
}

function getServerName(server: WrappableServer): string {
  const low = (server as { server?: { _serverInfo?: { name?: unknown } } }).server;
  const name = low?._serverInfo?.name;
  return typeof name === "string" && name.length > 0 ? name : "mcp-server";
}

function toolError(reason: string): { isError: true; content: Array<{ type: "text"; text: string }> } {
  return { isError: true, content: [{ type: "text", text: `blocked by policy: ${reason}` }] };
}

export function broker<T extends WrappableServer>(server: T, options: BrokerOptions): T {
  const deps: PipelineDeps = {
    serverName: getServerName(server),
    policy: resolvePolicySource(options.policy),
    secrets: resolveSecretSource(options.secrets),
    audit: resolveAuditSink(options.audit),
    identity: options.identity ?? defaultIdentityResolver,
    failMode: options.failMode ?? "closed",
    ...(options.approval ? { approval: options.approval } : {}),
    ...(options.redact ? { redact: options.redact } : {}),
  };

  // Wrap a registration callback so the pipeline runs before the author's
  // handler and the credential is injected onto the handler's context.
  const wrap = (toolName: string, origCb: (...a: unknown[]) => unknown) => {
    return async (...callArgs: unknown[]): Promise<unknown> => {
      // Schema tools are called (args, extra); zero-arg tools are called (extra).
      const extra = (callArgs[callArgs.length - 1] ?? {}) as McpHandlerExtra & { credential?: Credential };
      const args = callArgs.length > 1 ? callArgs[0] : undefined;

      const out = await runPipeline(deps, { toolName, args, extra }, async (credential) => {
        if (credential) extra.credential = credential;
        return origCb(...callArgs);
      });

      if (out.status === "blocked") return toolError(out.reason);
      return out.result;
    };
  };

  const origTool = server.tool.bind(server) as (...a: unknown[]) => unknown;
  server.tool = ((...args: unknown[]) => {
    const cb = args.pop() as (...a: unknown[]) => unknown;
    const name = args[0] as string;
    return origTool(...args, wrap(name, cb));
  }) as T["tool"];

  const origRegisterTool = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  server.registerTool = ((...args: unknown[]) => {
    const cb = args.pop() as (...a: unknown[]) => unknown;
    const name = args[0] as string;
    return origRegisterTool(...args, wrap(name, cb));
  }) as T["registerTool"];

  return server;
}
