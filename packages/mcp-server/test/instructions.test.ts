import { describe, it, expect } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AGENTVALET_INSTRUCTIONS, renderInstructions } from "../src/instructions.js";

describe("AGENTVALET_INSTRUCTIONS string", () => {
  it("is non-empty and contains the procedural anchors required by Phase 5", () => {
    expect(AGENTVALET_INSTRUCTIONS.length).toBeGreaterThan(500);
    expect(AGENTVALET_INSTRUCTIONS).toContain("use_platform");
    expect(AGENTVALET_INSTRUCTIONS).toContain("list_platforms");
    expect(AGENTVALET_INSTRUCTIONS).toContain("authzen_evaluate");
    expect(AGENTVALET_INSTRUCTIONS).toContain("pending_approval");
    expect(AGENTVALET_INSTRUCTIONS).toContain("Never bypass to raw API keys");
  });

  it("declares the broker aliases so the host LLM recognises AV / Valet / agentvalet", () => {
    expect(AGENTVALET_INSTRUCTIONS).toContain("\"AV\"");
    expect(AGENTVALET_INSTRUCTIONS).toContain("\"Valet\"");
    expect(AGENTVALET_INSTRUCTIONS).toContain("\"agentvalet\"");
  });

  it("includes the routing preference and fallback policy", () => {
    expect(AGENTVALET_INSTRUCTIONS).toContain("ROUTING PREFERENCE");
    expect(AGENTVALET_INSTRUCTIONS).toContain("Do not silently fall back");
  });
});

describe("renderInstructions(platformNames)", () => {
  it("renders without a platform line when no names provided", () => {
    const out = renderInstructions();
    expect(out).not.toContain("Platforms currently approved");
    expect(out).not.toContain("{{PLATFORMS_LINE}}");
  });

  it("inlines the platform catalogue when names are provided", () => {
    const out = renderInstructions(["Slack", "Stripe", "Airtable"]);
    expect(out).toContain("Platforms currently approved for this agent: Slack, Stripe, Airtable");
    expect(out).not.toContain("{{PLATFORMS_LINE}}");
  });

  it("ignores an empty platform list", () => {
    const out = renderInstructions([]);
    expect(out).not.toContain("Platforms currently approved");
  });
});

describe("InitializeResult.instructions wiring", () => {
  it("delivers the AgentValet instructions string to a connected client during initialize", async () => {
    const server = new Server(
      { name: "agentvalet", version: "test" },
      { capabilities: { tools: {} }, instructions: AGENTVALET_INSTRUCTIONS },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));

    const client = new Client(
      { name: "test-client", version: "0.0.0" },
      { capabilities: {} },
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    expect(client.getInstructions()).toBe(AGENTVALET_INSTRUCTIONS);

    await client.close();
    await server.close();
  });

  it("instructions are available before any tool calls (set in initialize, not lazily)", async () => {
    const server = new Server(
      { name: "agentvalet", version: "test" },
      { capabilities: { tools: {} }, instructions: AGENTVALET_INSTRUCTIONS },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));

    const client = new Client(
      { name: "test-client", version: "0.0.0" },
      { capabilities: {} },
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    // No tool calls have occurred. The instructions field must already be set
    // from the initialize handshake.
    const instructions = client.getInstructions();
    expect(instructions).toBeDefined();
    expect(instructions).toBe(AGENTVALET_INSTRUCTIONS);

    await client.close();
    await server.close();
  });
});
