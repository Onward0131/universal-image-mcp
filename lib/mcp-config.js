const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PRESETS = Object.freeze({
  openai: { baseUrl: "https://api.openai.com/v1", apiFormat: "openai-images", model: "", authType: "bearer" },
  "openai-compatible": { apiFormat: "openai-images", authType: "bearer" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiFormat: "gemini", authType: "header", authHeader: "x-goog-api-key" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiFormat: "openai-chat", authType: "bearer" },
});

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
  const configured = String(env.IMAGE_MCP_HOME || "").trim();
  return path.resolve(configured || path.join(homedir, ".universal-image-mcp"));
}

function mcpConfigPath(env = process.env, homedir = os.homedir()) {
  return env.IMAGE_MCP_CONFIG ? path.resolve(env.IMAGE_MCP_CONFIG) : path.join(defaultMcpHome(env, homedir), "config.json");
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

function normalizeBaseUrl(value, allowInsecureHttp = false) {
  let url;
  try { url = new URL(String(value)); } catch {
    throw new McpConfigError("请配置有效的API Base URL", "invalid_base_url");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new McpConfigError("Base URL必须是无凭据、查询参数和片段的HTTP(S)地址", "invalid_base_url");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !local && !allowInsecureHttp) {
    throw new McpConfigError("远程HTTP需要显式设置allow_insecure_http=true；建议使用HTTPS", "insecure_base_url");
  }
  return url.href.replace(/\/+$/, "");
}

function objectOption(value, name) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpConfigError(`${name}必须是JSON对象`, "invalid_config");
  }
  return value;
}

function resolveMcpConfig(overrides = {}) {
  const env = overrides.env || process.env;
  const homedir = overrides.homedir || os.homedir();
  const configFile = path.resolve(overrides.configFile || mcpConfigPath(env, homedir));
  if ((env.IMAGE_MCP_CONFIG || overrides.requireConfigFile) && !overrides.fileConfig && !fs.existsSync(configFile)) {
    throw new McpConfigError("显式指定的配置文件不存在", "config_not_found");
  }
  const fileConfig = overrides.fileConfig || readJsonFile(configFile);
  // A stored connection is authoritative as a unit. Environment URLs must never
  // redirect credentials stored for a different provider (including legacy keys).
  const storedConnection = ["provider", "base_url", "baseUrl", "api_key", "apiKey", "api_key_env"].some((key) => Object.hasOwn(fileConfig, key));
  const connectionEnv = storedConnection ? {} : env;
  const requestedBase = fileConfig.base_url ?? fileConfig.baseUrl ?? connectionEnv.IMAGE_API_BASE_URL;
  const provider = String(fileConfig.provider ?? connectionEnv.IMAGE_API_PROVIDER ?? "openai-compatible").trim();
  const preset = PRESETS[provider];
  if (!preset) throw new McpConfigError(`未知provider；支持${Object.keys(PRESETS).join(", ")}`, "invalid_provider");
  if (!requestedBase && !preset.baseUrl) throw new McpConfigError("请设置base_url或IMAGE_API_BASE_URL，或选择明确的官方provider", "base_url_required");
  const baseUrl = normalizeBaseUrl(requestedBase ?? preset.baseUrl, fileConfig.allow_insecure_http === true);
  const apiFormat = fileConfig.api_format ?? connectionEnv.IMAGE_API_FORMAT ?? preset.apiFormat;
  if (!["openai-images", "openai-chat", "gemini"].includes(apiFormat)) {
    throw new McpConfigError("api_format必须是openai-images、openai-chat或gemini", "invalid_api_format");
  }
  const officialOpenai = new URL(baseUrl).origin === "https://api.openai.com";
  const officialGemini = new URL(baseUrl).origin === "https://generativelanguage.googleapis.com";
  const keyEnvName = fileConfig.api_key_env;
  if (keyEnvName !== undefined && (typeof keyEnvName !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnvName))) {
    throw new McpConfigError("api_key_env必须是环境变量名称", "invalid_config");
  }
  const environmentKey = String(keyEnvName ? env[keyEnvName] || "" :
    env.IMAGE_API_KEY ||
    (provider === "openai" && officialOpenai ? env.OPENAI_API_KEY : "") ||
    (provider === "gemini" && officialGemini ? env.GEMINI_API_KEY : "") || "").trim();
  const storedKey = String(fileConfig.api_key ?? fileConfig.apiKey ?? "").trim();
  const authType = fileConfig.auth_type ?? preset.authType;
  if (!["bearer", "header", "none"].includes(authType)) throw new McpConfigError("auth_type必须是bearer、header或none", "invalid_config");
  const apiKey = authType === "none" ? "" : storedKey || environmentKey;
  if (/[\r\n]/.test(apiKey)) throw new McpConfigError("API Key不能包含换行", "invalid_config");
  const authHeader = fileConfig.auth_header ?? preset.authHeader ?? "api-key";
  if (typeof authHeader !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(authHeader) || /^(host|content-length|content-type|connection|transfer-encoding)$/i.test(authHeader)) {
    throw new McpConfigError("auth_header无效", "invalid_config");
  }
  const headers = {};
  const headerSecrets = [];
  for (const [name, value] of Object.entries(objectOption(fileConfig.headers, "headers"))) {
    if (typeof value !== "string") throw new McpConfigError("headers的值必须是字符串", "invalid_config");
    headers[name] = value;
  }
  for (const [name, variable] of Object.entries(objectOption(fileConfig.header_env, "header_env"))) {
    if (typeof variable !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new McpConfigError("header_env的值必须是环境变量名称", "invalid_config");
    if (!env[variable]) throw new McpConfigError("header_env引用的环境变量未设置", "missing_header_env");
    headers[name] = env[variable];
    headerSecrets.push(env[variable]);
  }
  for (const [name, value] of Object.entries(headers)) {
    if (/^(authorization|host|content-length|content-type|connection|transfer-encoding)$/i.test(name) || name.toLowerCase() === authHeader.toLowerCase() || /[\r\n]/.test(value)) {
      throw new McpConfigError("headers不能覆盖鉴权或HTTP传输头", "invalid_config");
    }
    try { new Headers({ [name]: value }); } catch { throw new McpConfigError("headers包含无效HTTP头", "invalid_config"); }
  }
  const endpointPaths = objectOption(fileConfig.endpoints, "endpoints");
  for (const [name, value] of Object.entries(endpointPaths)) {
    if (!["models", "generations", "edits", "chat", "generate_content"].includes(name) ||
        typeof value !== "string" || !/^\/(?!\/)/.test(value) || /[?#\\\s]/.test(value) ||
        value.split("/").some((part) => /^(\.|%2e){1,2}$/i.test(part))) {
      throw new McpConfigError("endpoints必须使用以单个/开头的安全相对路径", "invalid_endpoint");
    }
  }
  const extraBody = objectOption(fileConfig.extra_body, "extra_body");
  for (const name of ["model", "prompt", "n", "image", "mask", "messages", "contents", "stream", "tools", "input", "candidateCount"]) {
    if (Object.hasOwn(extraBody, name)) throw new McpConfigError(`extra_body不能覆盖${name}`, "invalid_config");
  }
  if (extraBody.generationConfig?.candidateCount !== undefined) throw new McpConfigError("extra_body不能修改candidateCount", "invalid_config");
  const omitFields = fileConfig.omit_fields ?? [];
  if (!Array.isArray(omitFields) || omitFields.some((name) => !["size", "quality", "output_format", "output_compression", "background", "moderation", "response_format"].includes(name))) {
    throw new McpConfigError("omit_fields包含不可省略的字段", "invalid_config");
  }
  const query = objectOption(fileConfig.query, "query");
  if (Object.entries(query).some(([name, value]) => /key|token|secret|authorization/i.test(name) || typeof value !== "string")) {
    throw new McpConfigError("query仅接受非敏感字符串参数；密钥请使用请求头", "invalid_config");
  }
  const timeoutMs = fileConfig.timeout_ms ?? 300000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 480000) throw new McpConfigError("timeout_ms必须在1000到480000之间", "invalid_config");
  for (const key of ["probe_models", "allow_insecure_http"]) {
    if (fileConfig[key] !== undefined && typeof fileConfig[key] !== "boolean") throw new McpConfigError(`${key}必须是布尔值`, "invalid_config");
  }
  if (extraBody.generationConfig !== undefined) objectOption(extraBody.generationConfig, "extra_body.generationConfig");

  return {
    apiKey,
    apiKeyPresent: Boolean(apiKey),
    authSource: authType === "none" ? "none" : storedKey ? "config" : environmentKey ? "env" : "missing",
    baseUrl,
    provider,
    apiFormat,
    model: String(fileConfig.model ?? connectionEnv.IMAGE_API_MODEL ?? (baseUrl === preset.baseUrl ? preset.model : "") ?? "").trim(),
    authType,
    authHeader,
    headers,
    query,
    endpoints: endpointPaths,
    extraBody,
    omitFields,
    probeModels: fileConfig.probe_models !== false,
    timeoutMs,
    secrets: [apiKey, ...headerSecrets, ...Object.entries(headers).filter(([name]) => /key|token|secret|authorization|cookie/i.test(name)).map(([, value]) => value)].filter(Boolean),
    configFile,
    homeDir: path.dirname(configFile),
    defaultOutputDir: path.resolve(overrides.defaultOutputDir || fileConfig.output_dir || env.IMAGE_OUTPUT_DIR || path.join(process.cwd(), "generated-images")),
  };
}

function maskApiKey(apiKey) {
  const value = String(apiKey || "");
  if (!value) return null;
  return "configured";
}

module.exports = {
  PRESETS,
  McpConfigError,
  defaultMcpHome,
  maskApiKey,
  mcpConfigPath,
  readJsonFile,
  normalizeBaseUrl,
  resolveMcpConfig,
};
