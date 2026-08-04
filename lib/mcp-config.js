const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_BASE_URL = "https://wawapii.com/v1";

class McpConfigError extends Error {
  constructor(message, code = "config_error") {
    super(message);
    this.name = "McpConfigError";
    this.code = code;
    this.status = 400;
    this.retryable = false;
  }
}

function defaultMcpHome(env = process.env, homedir = os.homedir()) {
  const configured = String(env.WAWAPI_IMAGE_HOME || "").trim();
  return path.resolve(configured || path.join(homedir, ".wawapi-image-mcp"));
}

function mcpConfigPath(env = process.env, homedir = os.homedir()) {
  return path.join(defaultMcpHome(env, homedir), "config.json");
}

function readJsonFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new McpConfigError(`配置文件格式错误：${filePath}`, "invalid_config");
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      throw new McpConfigError(`配置文件不是有效JSON：${filePath}`, "invalid_config");
    }
    throw error;
  }
}

function resolveMcpConfig(overrides = {}) {
  const env = overrides.env || process.env;
  const homedir = overrides.homedir || os.homedir();
  const configFile = path.resolve(overrides.configFile || mcpConfigPath(env, homedir));
  const fileConfig = overrides.fileConfig || readJsonFile(configFile);
  const environmentKey = String(env.WAWAPI_API_KEY || "").trim();
  const storedKey = String(fileConfig.api_key ?? fileConfig.apiKey ?? "").trim();
  const apiKey = storedKey || environmentKey;

  return {
    apiKey,
    apiKeyPresent: Boolean(apiKey),
    authSource: storedKey ? "config" : environmentKey ? "env" : "missing",
    baseUrl: DEFAULT_BASE_URL,
    configFile,
    homeDir: path.dirname(configFile),
    defaultOutputDir: path.resolve(overrides.defaultOutputDir || path.join(process.cwd(), "generated-images")),
  };
}

function maskApiKey(apiKey) {
  const value = String(apiKey || "");
  if (!value) return null;
  return "configured";
}

module.exports = {
  DEFAULT_BASE_URL,
  McpConfigError,
  defaultMcpHome,
  maskApiKey,
  mcpConfigPath,
  readJsonFile,
  resolveMcpConfig,
};
