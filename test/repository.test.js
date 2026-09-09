const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const skippedDirectories = new Set([".git", "node_modules", "release", "generated-images"]);
const binaryExtensions = new Set([".gif", ".jpg", ".jpeg", ".png", ".tgz", ".webp", ".zip"]);

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

async function listTextFiles(directory = root) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) {
        files.push(...await listTextFiles(path.join(directory, entry.name)));
      }
      continue;
    }
    if (entry.isFile() && !binaryExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

test("public repository metadata is complete", async () => {
  const requiredFiles = [
    "CHANGELOG.md",
    "CAPABILITIES.en.md",
    "CAPABILITIES.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "README.en.md",
    "README.md",
    "SECURITY.md",
    "docs/PROVIDERS.md",
    "docs/LIVE-TEST.md",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    "scripts/install.cmd",
    "scripts/test-codex-shim.cmd",
    "scripts/codex-cli-shim.mjs",
  ];
  for (const relativePath of requiredFiles) {
    const stat = await fs.stat(path.join(root, relativePath));
    assert.equal(stat.isFile(), true, `${relativePath} must be a file`);
  }

  const packageJson = JSON.parse(await read("package.json"));
  assert.equal(packageJson.name, "universal-image-mcp");
  assert.equal(packageJson.license, "MIT");
  assert.match(packageJson.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});

test("release documentation exposes capability boundaries and a double-click installer", async () => {
  const readme = await read("README.md");
  const englishReadme = await read("README.en.md");
  const launcher = await read("scripts/install.cmd");
  const installer = await read("scripts/install.ps1");
  const packageJson = JSON.parse(await read("package.json"));

  assert.match(readme, /双击[^\n]*`install\.cmd`/);
  assert.match(readme, /\[完整能力与降级表\]\(CAPABILITIES\.md\)/);
  assert.match(readme, /不需要预装Node\.js、npm或PowerShell 7/);
  assert.match(readme, /generation_channel_status/);
  assert.match(englishReadme, /double-click[^\n]*`install\.cmd`/i);
  assert.match(englishReadme, /\[complete capability and degradation matrix\]\(CAPABILITIES\.en\.md\)/i);
  assert.match(englishReadme, /No preinstalled Node\.js, npm, PowerShell 7/i);
  assert.match(launcher, /WindowsPowerShell\\v1\.0\\powershell\.exe/i);
  assert.match(launcher, /-File "%~dp0install\.ps1" -Friendly/);
  assert.match(installer, /node-v24\.19\.0-win-x64\.zip/);
  assert.match(installer, /57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73/);
  assert.match(installer, /node-v24\.19\.0-win-arm64\.zip/);
  assert.match(installer, /8502f4a50b458d4cc38ed8f2001556c2cd239d464920f74017926ccb1e1c157f/);
  assert.match(installer, /https:\/\/nodejs\.org\/dist\/v/);
  assert.match(installer, /"--offline"/);
  assert.match(installer, /CodexToolTimeoutSec = 600/);
  assert.match(installer, /tool_timeout_sec/);
  assert.match(await read("scripts/test-windows-install.ps1"), /UseInstalledCodex/);
  assert.match(readme, /MCP工具超时[^\n]*600秒/);
  assert.match(englishReadme, /MCP tool timeout[^\n]*600 seconds/i);
  assert.doesNotMatch(installer, /Get-Command node\b/);
  assert.doesNotMatch(installer, /\$IsWindows\b/);
  assert.doesNotMatch(installer, /-MaskInput\b/);
  assert.doesNotMatch(installer, /File\]::Move\([^\n]+,\s*\$true\)/);
  assert.ok(packageJson.files.includes("CAPABILITIES.md"));
  assert.ok(packageJson.files.includes("CAPABILITIES.en.md"));
  assert.deepEqual(packageJson.bundleDependencies.sort(), ["@modelcontextprotocol/sdk", "zod"]);
});

test("Skill metadata is concise and declares the MCP dependency", async () => {
  const skill = await read("skills/universal-image/SKILL.md");
  const frontmatter = /^---\r?\n([\s\S]+?)\r?\n---/.exec(skill);
  assert.ok(frontmatter, "SKILL.md must begin with YAML frontmatter");
  const keys = frontmatter[1]
    .split(/\r?\n/)
    .map((line) => /^([a-z0-9_-]+):/.exec(line)?.[1])
    .filter(Boolean)
    .sort();
  assert.deepEqual(keys, ["description", "name"]);
  assert.match(frontmatter[1], /^name: universal-image$/m);
  assert.ok(skill.split(/\r?\n/).length < 500, "SKILL.md should stay below 500 lines");
  assert.match(skill, /catalog_status=unverified[^\n]+non-blocking/i);
  assert.match(skill, /generation_channel_status=not_probed/);
  assert.match(skill, /do not send beginners into a separate Node\.js installation workflow/i);
  assert.match(skill, /MCP error -32001: Request timed out/);

  const liveSmoke = await read("scripts/live-mcp-smoke.mjs");
  assert.match(liveSmoke, /LIVE_TOOL_TIMEOUT_MS = 600_000/);
  assert.match(liveSmoke, /maxTotalTimeout: LIVE_TOOL_TIMEOUT_MS/);

  const agentMetadata = await read("skills/universal-image/agents/openai.yaml");
  assert.match(agentMetadata, /default_prompt: ".*\$universal-image/);
  assert.match(agentMetadata, /type: "mcp"/);
  assert.match(agentMetadata, /value: "universal-image"/);
  assert.match(agentMetadata, /transport: "stdio"/);
});

test("repository text files contain no credential-like values or retired product names", async () => {
  const patterns = [
    {
      name: "provider-style API Key",
      expression: new RegExp(`\\b${["s", "k"].join("")}-[A-Za-z0-9_-]{24,}\\b`),
    },
    {
      name: "GitHub token",
      expression: new RegExp(`\\b${["g", "h"].join("")}[pousr]_[A-Za-z0-9]{30,}\\b`),
    },
    {
      name: "private key block",
      expression: new RegExp([
        ["---", "--BE", "GIN"].join(""),
        ["PRI", "VATE KEY", "-----"].join(""),
      ].join("[\\s\\S]{0,32}")),
    },
    {
      name: "retired environment variable",
      expression: new RegExp(["IMAGE", "_RETIRED_HOME"].join("")),
    },
    {
      name: "retired installation name",
      expression: new RegExp(["retired", "-image-product"].join(""), "i"),
    },
  ];

  patterns.push({ name: "removed vendor name", expression: new RegExp(["wa", "wapi"].join(""), "i") });
  const findings = [];
  for (const filePath of await listTextFiles()) {
    const content = await fs.readFile(filePath, "utf8");
    for (const pattern of patterns) {
      if (pattern.expression.test(content)) {
        findings.push(`${path.relative(root, filePath)}: ${pattern.name}`);
      }
    }
  }
  assert.deepEqual(findings, []);
});
