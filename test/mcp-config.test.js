const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_BASE_URL,
  defaultMcpHome,
  maskApiKey,
  mcpConfigPath,
  resolveMcpConfig,
} = require("../lib/mcp-config");

test("doctor auth status never reveals an API Key suffix", () => {
  assert.equal(maskApiKey("secret-value-123456789"), "configured");
  assert.equal(maskApiKey(""), null);
});

async function tempHome(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wawapi-image-mcp-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("MCP state defaults to a dedicated user directory", () => {
  assert.equal(defaultMcpHome({}, "C:\\Users\\Test"), path.resolve("C:\\Users\\Test", ".wawapi-image-mcp"));
  assert.equal(
    mcpConfigPath({ WAWAPI_IMAGE_HOME: "D:\\CodexTools\\wawapi-image-mcp\\state" }),
    path.resolve("D:\\CodexTools\\wawapi-image-mcp\\state", "config.json"),
  );
});

test("unrelated historical environment variables are ignored", () => {
  assert.equal(
    defaultMcpHome({ LEGACY_IMAGE_HOME: "D:\\unrelated-state" }, "C:\\Users\\Test"),
    path.resolve("C:\\Users\\Test", ".wawapi-image-mcp"),
  );
});

test("protected config takes precedence and WAWAPI_API_KEY remains a fallback", async (t) => {
  const home = await tempHome(t);
  const configFile = path.join(home, "config.json");
  await fs.writeFile(configFile, JSON.stringify({ api_key: "stored-secret-123456789" }));

  const withBoth = resolveMcpConfig({
    env: { WAWAPI_API_KEY: "env-secret-123456789" },
    configFile,
  });
  assert.equal(withBoth.authSource, "config");
  assert.equal(withBoth.apiKey, "stored-secret-123456789");

  const fromConfig = resolveMcpConfig({ env: {}, configFile });
  assert.equal(fromConfig.authSource, "config");
  assert.equal(fromConfig.apiKey, "stored-secret-123456789");

  await fs.rm(configFile);
  const fromEnvironment = resolveMcpConfig({
    env: { WAWAPI_API_KEY: "env-secret-123456789" },
    configFile,
  });
  assert.equal(fromEnvironment.authSource, "env");
  assert.equal(fromEnvironment.apiKey, "env-secret-123456789");
});

test("unrelated OpenAI and Base URL settings are ignored", async (t) => {
  const home = await tempHome(t);
  const configFile = path.join(home, "config.json");
  await fs.writeFile(configFile, JSON.stringify({
    base_url: "https://attacker.invalid/v1",
  }));
  const resolved = resolveMcpConfig({
    env: {
      OPENAI_API_KEY: "must-not-be-used",
      WAWAPI_BASE_URL: "https://attacker.invalid/v1",
    },
    configFile,
  });
  assert.equal(resolved.apiKeyPresent, false);
  assert.equal(resolved.authSource, "missing");
  assert.equal(resolved.baseUrl, DEFAULT_BASE_URL);
});
