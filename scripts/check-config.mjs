import configModule from "../lib/mcp-config.js";

try {
  const config = configModule.resolveMcpConfig({ configFile: process.argv[2], requireConfigFile: Boolean(process.argv[2]) });
  process.stdout.write(`${JSON.stringify({
    ok: true, provider: config.provider, api_format: config.apiFormat,
    base_url: config.baseUrl, model: config.model || null,
    auth_type: config.authType, credentials_configured: config.apiKeyPresent,
    probe_models: config.probeModels, config_file: config.configFile,
  })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: error.code || "invalid_config", message: error.code ? error.message : "无法读取供应商配置" })}\n`);
  process.exitCode = 1;
}
