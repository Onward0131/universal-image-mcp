import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh3cAAAAASUVORK5CYII=";

test("stdio tools generate and edit through each adapter, reload config, and contain config errors", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "image-stdio-test-"));
  const configPath = path.join(root, "provider.json");
  const reference = path.join(root, "reference.png");
  await fs.writeFile(reference, Buffer.from(png, "base64"));
  const received = [];
  const fakeProvider = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ url: req.url, body, contentType: req.headers["content-type"] });
    res.setHeader("content-type", "application/json");
    if (req.url.includes("generateContent")) {
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png } }] } }] }));
    } else if (req.url.includes("completions")) {
      res.end(JSON.stringify({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${png}` } }] } }] }));
    } else res.end(JSON.stringify({ data: [{ b64_json: png }] }));
  });
  fakeProvider.listen(0, "127.0.0.1");
  await once(fakeProvider, "listening");
  const client = new Client({ name: "provider-stdio-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    fakeProvider.closeAllConnections();
    await new Promise((done) => fakeProvider.close(done));
    await fs.rm(root, { recursive: true, force: true });
  });
  const transport = new StdioClientTransport({
    command: process.env.IMAGE_TEST_NODE || process.execPath,
    args: [path.join(process.env.IMAGE_TEST_PACKAGE_ROOT || projectRoot, "bin/universal-image-mcp.mjs")],
    env: { ...process.env, IMAGE_MCP_CONFIG: configPath },
    stderr: "pipe",
  });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 6);

  for (const api_format of ["openai-images", "gemini", "openai-chat"]) {
    await fs.writeFile(configPath, JSON.stringify({
      provider: "openai-compatible", api_format, model: "custom-art",
      base_url: `http://127.0.0.1:${fakeProvider.address().port}/api/v1`,
      auth_type: "none", probe_models: false,
    }));
    for (const name of ["generate_image", "edit_image"]) {
      const result = await client.callTool({ name, arguments: {
        prompt: "tree", out: path.join(root, `${api_format}-${name}.png`),
        ...(name === "edit_image" ? { reference_path: reference } : {}),
      } });
      assert.equal(result.isError, undefined, result.content[0]?.text);
      assert.deepEqual(result.content.map((item) => item.type), ["text"]);
      assert.doesNotMatch(JSON.stringify(result), /b64_json|iVBORw0|data:image/);
      const envelope = JSON.parse(result.content[0].text);
      assert.equal(envelope.ok, true);
      assert.equal(envelope.data.provider.api_format, api_format);
      assert.equal(envelope.data.result.images[0].size, "1x1");
      assert.equal((await fs.readFile(envelope.data.result.images[0].path)).toString("base64"), png);
    }
  }
  assert.equal(received.length, 6);
  assert.match(received[1].contentType, /^multipart\/form-data; boundary=/);
  assert.match(received[1].body, /name="image"; filename="reference.png"/);
  assert.equal(JSON.parse(received[3].body).contents[0].parts[1].inlineData.data, png);
  assert.equal(JSON.parse(received[5].body).messages[0].content[1].image_url.url, `data:image/png;base64,${png}`);

  await fs.writeFile(configPath, "{ broken JSON private-test-key");
  const error = await client.callTool({ name: "image_doctor", arguments: { probe_catalog: false } });
  assert.equal(error.isError, true);
  assert.equal(JSON.parse(error.content[0].text).error.code, "invalid_config");
  assert.doesNotMatch(JSON.stringify(error), /private-test-key/);
  assert.equal((await client.listTools()).tools.length, 6, "config errors must not kill the MCP process");
});
