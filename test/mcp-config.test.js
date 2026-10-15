const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "universal-image-mcp-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("MCP state defaults to a dedicated user directory", () => {
  assert.equal(defaultMcpHome({}, "C:\\Users\\Test"), path.resolve("C:\\Users\\Test", ".universal-image-mcp"));
  assert.equal(
    mcpConfigPath({ IMAGE_MCP_HOME: "D:\\CodexTools\\universal-image-mcp\\state" }),
    path.resolve("D:\\CodexTools\\universal-image-mcp\\state", "config.json"),
  );
});

test("unrelated historical environment variables are ignored", () => {
  assert.equal(
    defaultMcpHome({ LEGACY_IMAGE_HOME: "D:\\unrelated-state" }, "C:\\Users\\Test"),
    path.resolve("C:\\Users\\Test", ".universal-image-mcp"),
  );
});

test("protected config takes precedence and IMAGE_API_KEY remains a fallback", async (t) => {
  const home = await tempHome(t);
  const configFile = path.join(home, "config.json");
  await fs.writeFile(configFile, JSON.stringify({ base_url: "https://chosen.example/v1", api_key: "stored-secret-123456789" }));

  const withBoth = resolveMcpConfig({
    env: { IMAGE_API_KEY: "env-secret-123456789", IMAGE_API_BASE_URL: "https://chosen.example/v1" },
    configFile,
  });
  assert.equal(withBoth.authSource, "config");
  assert.equal(withBoth.apiKey, "stored-secret-123456789");

  const fromConfig = resolveMcpConfig({ env: {}, configFile });
  assert.equal(fromConfig.authSource, "config");
  assert.equal(fromConfig.apiKey, "stored-secret-123456789");

  await fs.rm(configFile);
  const fromEnvironment = resolveMcpConfig({
    env: { IMAGE_API_KEY: "env-secret-123456789", IMAGE_API_BASE_URL: "https://chosen.example/v1" },
    configFile,
  });
  assert.equal(fromEnvironment.authSource, "env");
  assert.equal(fromEnvironment.apiKey, "env-secret-123456789");
});

test("a configured third-party URL never picks up an unrelated OpenAI key", async (t) => {
  const home = await tempHome(t);
  const configFile = path.join(home, "config.json");
  await fs.writeFile(configFile, JSON.stringify({
    base_url: "https://attacker.invalid/v1",
  }));
  const resolved = resolveMcpConfig({
    env: {
      OPENAI_API_KEY: "must-not-be-used",
      IMAGE_API_BASE_URL: "https://attacker.invalid/v1",
    },
    configFile,
  });
  assert.equal(resolved.apiKeyPresent, false);
  assert.equal(resolved.authSource, "missing");
  assert.equal(resolved.baseUrl, "https://attacker.invalid/v1");
});
