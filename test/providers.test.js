const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { once } = require("node:events");
const { resolveMcpConfig } = require("../lib/mcp-config");
const { createImageApi, buildGenerationPayload } = require("../lib/image-api");
const { generateImage, explain, doctor, errorEnvelope } = require("../lib/bridge");

// A real 1x1 PNG, rather than a generated/billable test image.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh3cAAAAASUVORK5CYII=";
const jsonResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const imageResponse = () => jsonResponse({ data: [{ b64_json: png }] });
const resolve = (fileConfig = {}, env = {}) => resolveMcpConfig({ fileConfig, env });
const compatible = (values = {}) => resolve({ provider: "openai-compatible", base_url: "https://third.example/api/v2/", model: "custom-art", api_key: "test-key", ...values });

test("stored connection cannot be redirected by environment variables", () => {
  const config = resolve({ base_url: "https://chosen.example/v1", api_key: "stored-key" }, { IMAGE_API_BASE_URL: "https://other.example/v1", IMAGE_API_PROVIDER: "gemini", IMAGE_API_KEY: "env-key" });
  assert.equal(config.baseUrl, "https://chosen.example/v1");
  assert.equal(config.apiKey, "stored-key");
  assert.equal(config.provider, "openai-compatible");
});

test("environment-only custom connection is normalized without adding a version prefix", () => {
  const config = resolve({}, { IMAGE_API_BASE_URL: "https://third.example/openai///", IMAGE_API_KEY: "env-key", IMAGE_API_MODEL: "vendor/custom" });
  assert.equal(config.baseUrl, "https://third.example/openai");
  assert.equal(config.model, "vendor/custom");
  assert.equal(config.apiKey, "env-key");
});

test("an unconfigured server cannot select a service or send credentials", () => {
  assert.throws(() => resolve({}, { IMAGE_API_KEY: "unbound-key" }), { code: "base_url_required" });
  assert.throws(() => resolve({ api_key: "unbound-key" }, { IMAGE_API_BASE_URL: "https://other.example" }), { code: "base_url_required" });
});

test("keyless connections ignore credentials from both config and environment", () => {
  const config = resolve({ provider: "openai-compatible", base_url: "http://localhost:8080/v1", auth_type: "none", api_key: "stored-key" }, { IMAGE_API_KEY: "unrelated-key" });
  assert.equal(config.apiKeyPresent, false);
  assert.equal(config.apiKey, "");
  assert.equal(config.authSource, "none");
});

test("official credentials are only inferred for their explicitly selected official origin", () => {
  const env = { OPENAI_API_KEY: "official-key", GEMINI_API_KEY: "google-key" };
  assert.equal(resolve({ provider: "openai" }, env).apiKey, "official-key");
  assert.equal(resolve({ provider: "gemini" }, env).apiKey, "google-key");
  assert.equal(resolve({ provider: "openai", base_url: "https://third.example/v1" }, env).apiKeyPresent, false);
  assert.equal(resolve({ provider: "gemini", base_url: "https://third.example/v1beta" }, env).apiKeyPresent, false);
  assert.equal(resolve({ provider: "openai-compatible", base_url: "https://third.example", api_key_env: "MY_KEY" }, { MY_KEY: "explicit-key", IMAGE_API_KEY: "unrelated" }).apiKey, "explicit-key");
});


test("missing explicitly named config cannot fall back to another connection", () => {
  assert.throws(() => resolveMcpConfig({ env: { IMAGE_MCP_CONFIG: path.join(os.tmpdir(), `missing-${Date.now()}.json`) } }), { code: "config_not_found" });
});

test("configuration rejects unsafe URLs, credentials in queries, and payload overrides", () => {
  for (const base_url of ["file:///tmp/api", "https://user:pass@example.com", "https://example.com?key=test", "https://example.com/#test", "http://192.168.1.1/v1"]) {
    assert.throws(() => compatible({ base_url }));
  }
  for (const invalid of [
    { endpoints: { generations: "//other.example/path" } },
    { endpoints: { models: "/../models" } },
    { endpoints: { models: "/%2e%2e/models" } },
    { headers: { Authorization: "test" } },
    { headers: { "x-meta": "value\r\ninjected: yes" } },
    { extra_body: { model: "other" } }, { extra_body: { n: 100 } },
    { extra_body: { generationConfig: { candidateCount: 8 } } },
    { omit_fields: ["prompt"] }, { query: { "api-key": "test" } },
    { api_format: "invented" }, { timeout_ms: 0 },
  ]) assert.throws(() => compatible(invalid));
  assert.equal(compatible({ base_url: "http://localhost:8080/v1" }).baseUrl, "http://localhost:8080/v1");
  assert.equal(compatible({ base_url: "http://192.168.1.1/v1", allow_insecure_http: true }).baseUrl, "http://192.168.1.1/v1");
});

test("custom header auth, deployment prefix, query, and generation parameters reach the wire", async () => {
  const config = compatible({ auth_type: "header", auth_header: "api-key", query: { "api-version": "test-version" }, endpoints: { generations: "/render" }, extra_body: { seed: 42 }, omit_fields: ["moderation"] });
  let calls = 0;
  await createImageApi(config, async (url, options) => {
    calls++;
    assert.equal(url, "https://third.example/api/v2/render?api-version=test-version");
    assert.equal(options.headers["api-key"], "test-key");
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, "manual");
    assert.deepEqual(JSON.parse(options.body), { seed: 42, prompt: "render a tree", model: "custom-art", n: 1, size: "1024x1024" });
    return imageResponse();
  }).generate({ prompt: "render a tree", size: "1024x1024", moderation: "auto" });
  assert.equal(calls, 1);
});

test("DALL-E accepts its own quality and omits GPT Image-only defaults", async () => {
  const api = createImageApi(compatible({ model: "dall-e-3" }), async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { model: "dall-e-3", prompt: "tree", n: 1, quality: "hd", response_format: "b64_json" });
    return imageResponse();
  });
  await api.generate({ prompt: "tree", quality: "hd", responseFormat: "b64_json", outputFormat: "auto", size: "auto" });
  await assert.rejects(api.generate({ prompt: "tree", n: 2 }), { code: "unsupported_operation" });
});

test("generic billable requests never probe async or replay 429, 503, redirects, or network errors", async () => {
  for (const outcome of [
    () => jsonResponse({ error: { message: "rate limited" } }, 429),
    () => jsonResponse({ error: { message: "No available channel" } }, 503),
    () => new Response(null, { status: 307, headers: { location: "https://elsewhere.example" } }),
    () => { throw new TypeError("network interrupted"); },
  ]) {
    let calls = 0;
    await assert.rejects(createImageApi(compatible(), async () => { calls++; return outcome(); }).generate({ prompt: "tree" }));
    assert.equal(calls, 1);
  }
});

test("direct API clients also submit billable requests only once", async () => {
  let calls = 0;
  const api = createImageApi({ baseUrl: "https://third.example/v1", apiKey: "test", model: "custom-art" }, async () => {
    calls++;
    return jsonResponse({ error: { message: "rate limited" } }, 429);
  });
  await assert.rejects(api.generate({ prompt: "tree" }));
  assert.equal(calls, 1);
});

test("every adapter rejects a missing or blank model before submitting generate or edit", async () => {
  for (const api_format of ["openai-images", "gemini", "openai-chat"]) {
    for (const model of [undefined, "", " \t "]) {
      let calls = 0;
      const api = createImageApi(compatible({ api_format, model }), async () => {
        calls++;
        return imageResponse();
      });
      await assert.rejects(api.generate({ prompt: "tree" }), { code: "model_required" });
      await assert.rejects(api.edit({
        prompt: "edit tree", referenceImage: { dataUrl: `data:image/png;base64,${png}` },
      }), { code: "model_required" });
      assert.equal(calls, 0, `${api_format} must not submit without an explicit model`);
    }
  }
});

test("response limits stop oversized JSON before reading the body", async () => {
  const api = createImageApi(compatible(), async () => new Response("{}", { headers: { "content-length": String(101 * 1024 * 1024) } }));
  await assert.rejects(api.generate({ prompt: "tree" }), { code: "response_too_large" });
});

test("Gemini request uses native parts, auth header and encoded model path", async () => {
  const config = resolve({ provider: "gemini", model: "models/custom-image", api_key: "google-test", extra_body: { generationConfig: { imageConfig: { aspectRatio: "16:9" } } } });
  const calls = [];
  const api = createImageApi(config, async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ candidates: [{ content: { parts: [
      { thought: true, inlineData: { mimeType: "image/png", data: png } },
      { text: "A tree" }, { inlineData: { mimeType: "image/png", data: png } },
    ] } }], usageMetadata: { totalTokenCount: 10 } });
  });
  const result = await api.edit({ model: config.model, prompt: "edit tree", referenceImage: { dataUrl: `data:image/png;base64,${png}` }, size: "auto", outputFormat: "auto" });
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/custom-image:generateContent");
  assert.equal(calls[0].options.headers["x-goog-api-key"], "google-test");
  assert.equal(calls[0].options.headers.Authorization, undefined);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.contents[0].parts[1].inlineData.data, png);
  assert.deepEqual(body.generationConfig, { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9" }, candidateCount: 1 });
  assert.equal(result.images.length, 1);
  assert.equal(result.usage.totalTokenCount, 10);
});

test("chat-style image output handles structured data URLs and Markdown", async () => {
  for (const message of [
    { images: [{ image_url: { url: `data:image/png;base64,${png}` } }] },
    { content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }] },
    { content: `![tree](data:image/png;base64,${png})` },
  ]) {
    const api = createImageApi(resolve({ provider: "openrouter", model: "vendor/art", api_key: "key" }), async (url, options) => {
      assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
      const body = JSON.parse(options.body);
      assert.equal(body.stream, false);
      assert.equal(body.messages[0].content[0].text, "tree");
      return jsonResponse({ choices: [{ message }] });
    });
    const result = await api.generate({ prompt: "tree" });
    assert.equal(result.images[0].value, png);
  }
});

test("unsupported content API parameters stop before any billable request", async () => {
  let calls = 0;
  const api = createImageApi(resolve({ provider: "gemini", api_key: "key", model: "custom-image" }), async () => { calls++; return imageResponse(); });
  for (const options of [{ n: 2 }, { quality: "high" }, { outputFormat: "webp" }, { size: "2048x2048" }]) {
    await assert.rejects(api.generate({ prompt: "tree", ...options }));
  }
  assert.equal(calls, 0);
  assert.throws(() => buildGenerationPayload({ prompt: "tree", n: "2abc" }), { code: "invalid_count" });
  assert.throws(() => buildGenerationPayload({ prompt: "tree", n: 1.5 }), { code: "invalid_count" });
});

test("Gemini safety refusal is distinct from a missing image", async () => {
  const api = createImageApi(resolve({ provider: "gemini", model: "custom-image", api_key: "key" }), async () => jsonResponse({ promptFeedback: { blockReason: "SAFETY" } }));
  await assert.rejects(api.generate({ prompt: "tree" }), { code: "content_blocked" });
});

test("provider capability explanation starts without imported historical evidence", async () => {
  const result = await explain(compatible({ model: "gpt-image-2-high" }), { size: "2048x2048", offline: true });
  assert.equal(result.data.explanation.expectedStatus, "unknown");
  assert.deepEqual(result.data.explanation.evidence, []);
  assert.equal(result.data.explanation.selectionReason, "configured_model");
});

test("doctor supports keyless local gateways and opt-out of model probing", async () => {
  let calls = 0;
  const result = await doctor(compatible({ auth_type: "none", api_key: "", probe_models: false }), { fetchImpl: async () => { calls++; } });
  assert.equal(result.data.ready, true);
  assert.equal(result.data.checks.auth.status, "not_required");
  assert.equal(result.data.catalog_status, "not_probed");
  assert.equal(calls, 0);
});

test("real local HTTP to disk works for all protocols without a model catalog", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "image-provider-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: JSON.parse(body), headers: req.headers });
    res.setHeader("content-type", "application/json");
    const payload = req.url.includes("generateContent")
      ? { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png } }] } }] }
      : req.url.includes("completions") ? { choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${png}` } }] } }] }
      : { data: [{ b64_json: png }] };
    res.end(JSON.stringify(payload));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (const api_format of ["openai-images", "gemini", "openai-chat"]) {
    const config = compatible({ base_url: `http://127.0.0.1:${server.address().port}/v1`, api_format, probe_models: false });
    const result = await generateImage(config, { prompt: "tree", output: path.join(root, `${api_format}.png`) });
    assert.equal(result.data.result.actual_count, 1);
    assert.equal(result.data.result.status, "exact");
    assert.equal(result.data.result.images[0].size, "1x1");
    assert.equal((await fs.readFile(result.data.result.images[0].path)).toString("base64"), png);
    assert.equal(result.data.provider.model_catalog_status, "not_probed");
    assert.equal(result.data.capability.evidence.length, 0);
  }
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0].body, { model: "custom-art", prompt: "tree", n: 1 });
});

test("explicit models absent from a generic catalog are sent unchanged", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "image-provider-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await generateImage(compatible(), { prompt: "tree", model: "unlisted-deployment", output: root }, { fetchImpl: async (url, options) => {
    if (url.endsWith("/models")) return jsonResponse({ data: [{ id: "text-model" }] });
    assert.equal(JSON.parse(options.body).model, "unlisted-deployment");
    return imageResponse();
  } });
  assert.equal(result.data.request.model, "unlisted-deployment");
});

test("no generic model is invented when discovery fails", async () => {
  let generationCalls = 0;
  await assert.rejects(generateImage(compatible({ model: "" }), { prompt: "tree" }, { catalogMaxRetries: 0, fetchImpl: async (url) => {
    if (url.endsWith("/models")) return jsonResponse({}, 404);
    generationCalls++;
    return imageResponse();
  } }), { code: "model_required" });
  assert.equal(generationCalls, 0);
});

test("error guidance and request ids redact custom secrets", () => {
  const result = errorEnvelope("test", Object.assign(new Error("oops private-key"), { requestId: "private-key", nextActions: ["private-key"] }), ["private-key"]);
  assert.doesNotMatch(JSON.stringify(result), /private-key/);
});

test("concurrent same-name results retain every file and never overwrite", async (t) => {
  t.mock.method(Date, "now", () => 1788912000000);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "image-collision-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const out = path.join(root, "art.png");
  await fs.writeFile(out, "existing-user-file");
  const results = await Promise.all(Array.from({ length: 8 }, () => generateImage(
    compatible({ probe_models: false }), { prompt: "tree", output: out }, { fetchImpl: async () => imageResponse() },
  )));
  const paths = results.map((result) => result.data.result.images[0].path);
  assert.equal(new Set(paths).size, 8);
  assert.equal(await fs.readFile(out, "utf8"), "existing-user-file");
  for (const file of paths) assert.equal((await fs.readFile(file)).toString("base64"), png);
});
