import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { createUniversalImageMcpServer } from "../bin/universal-image-mcp.mjs";

test("MCP lists text-only image tools and calls offline capability explanation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-contract-"));
  const configPath = path.join(root, "config.json");
  await fs.writeFile(configPath, JSON.stringify({ provider: "openai-compatible", base_url: "https://provider.example/v1", model: "image-test" }));
  const original = process.env.IMAGE_MCP_CONFIG;
  process.env.IMAGE_MCP_CONFIG = configPath;
  t.after(async () => { if (original === undefined) delete process.env.IMAGE_MCP_CONFIG; else process.env.IMAGE_MCP_CONFIG = original; await fs.rm(root, { recursive: true, force: true }); });
  const server = createUniversalImageMcpServer();
const client = new Client({ name: "universal-image-mcp-test-client", version: packageJson.version });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "image_doctor",
    "list_image_models",
    "explain_image_capability",
    "generate_image",
    "edit_image",
    "inspect_image",
  ]);
  const generateTool = listed.tools.find((tool) => tool.name === "generate_image");
  const doctorTool = listed.tools.find((tool) => tool.name === "image_doctor");
  const explainTool = listed.tools.find((tool) => tool.name === "explain_image_capability");
  assert.match(generateTool.description, /text-only/i);
  assert.match(generateTool.description, /300 seconds/i);
  assert.equal(Object.hasOwn(generateTool.inputSchema.properties, "timeout_ms"), false);
  assert.match(generateTool.description, /configures Codex to allow 600 seconds/);
  assert.equal(Object.hasOwn(generateTool.inputSchema.properties, "async_mode"), false);
  assert.equal(Object.hasOwn(doctorTool.inputSchema.properties, "probe_catalog"), true);
  assert.match(doctorTool.description, /cannot prove/i);
  assert.equal(Object.hasOwn(explainTool.inputSchema.properties, "count"), true);
  assert.match(explainTool.description, /multiple-image/i);

  const doctorCalled = await client.callTool({
    name: "image_doctor",
    arguments: { probe_catalog: false },
  });
  const doctorEnvelope = JSON.parse(doctorCalled.content[0].text);
  assert.equal(doctorEnvelope.data.generation_channel_status, "not_probed");
  assert.ok(doctorEnvelope.data.issues.length > 0);

  const called = await client.callTool({
    name: "explain_image_capability",
    arguments: { size: "1024x1024", format: "jpeg", count: 2, offline: true },
  });
  assert.equal(called.isError, undefined);
  assert.deepEqual(called.content.map((item) => item.type), ["text"]);
  assert.equal(called.content.some((item) => item.type === "image"), false);
  const envelope = JSON.parse(called.content[0].text);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.selection_scope, "configured_provider");
  assert.equal(envelope.data.explanation.selectedModel, "image-test");
  assert.equal(envelope.data.explanation.requestedCount, 2);
  assert.equal(envelope.data.explanation.expectedCountStatus, "unknown");
  assert.deepEqual(envelope.data.explanation.evidence, []);
});
