const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { createImageApi, MAX_REFERENCE_IMAGE_BYTES } = require("./image-api");
const { createModelCatalog } = require("./model-catalog");
const { createStorage, inspectImage } = require("./storage");
const {
  aspectStatus,
  explainCapability,
  ratioErrorPercent,
  selectModel,
} = require("./capabilities");
const { maskApiKey } = require("./mcp-config");

const SCHEMA_VERSION = 1;
const KNOWN_MODELS = [
  "gpt-image-2",
  "gpt-image-2-high",
  "gpt-image-2-low",
  "gpt-image-2-medium",
];
const VALID_FORMATS = new Set(["png", "jpeg", "webp"]);
const VALID_QUALITIES = new Set(["low", "medium", "high", "auto"]);

class McpBridgeError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "McpBridgeError";
    this.code = options.code || "mcp_bridge_error";
    this.status = options.status || 0;
    this.retryable = Boolean(options.retryable);
    this.requestId = options.requestId || null;
    this.attempts = options.attempts || 1;
    this.details = options.details || null;
    this.nextActions = options.nextActions || [];
  }
}

function normalizeFormat(value) {
  const normalized = String(value || "png").trim().toLowerCase();
  return normalized === "jpg" ? "jpeg" : normalized;
}

function extensionForFormat(format) {
  return normalizeFormat(format) === "jpeg" ? ".jpg" : `.${normalizeFormat(format)}`;
}

function formatForExtension(extension) {
  return {
    ".jpg": "jpeg",
    ".jpeg": "jpeg",
    ".png": "png",
    ".webp": "webp",
  }[String(extension || "").toLowerCase()] || null;
}

function successEnvelope(command, data, warnings = []) {
  return {
    schema_version: SCHEMA_VERSION,
    ok: true,
    command,
    data,
    warnings,
  };
}

function redactText(value, secrets = []) {
  let text = String(value || "");
  for (const secret of secrets.filter(Boolean)) {
    text = text.split(String(secret)).join("[REDACTED]");
  }
  text = text.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");
  return text;
}

function redactValue(value, secrets = [], depth = 0) {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets, depth + 1)]),
    );
  }
  return value;
}

function errorEnvelope(command, error, secrets = []) {
  const message = redactText(error?.message || "Unknown error", secrets);
  const details = redactValue(error?.details || null, secrets);
  const diagnostics = {
    phase: error?.phase || details?.phase || null,
    target: error?.target || details?.target || null,
    network_category: error?.networkCategory || details?.network_category || null,
    cause_code: error?.causeCode || details?.cause_code || null,
  };
  return {
    schema_version: SCHEMA_VERSION,
    ok: false,
    command,
    error: {
      code: error?.code || "unexpected_error",
      message,
      status: Number(error?.status) || 0,
      request_id: error?.requestId || null,
      retryable: Boolean(error?.retryable),
      attempts: Number(error?.attempts) || 1,
      details,
      diagnostics,
    },
    next_actions: Array.isArray(error?.nextActions) ? error.nextActions : [],
  };
}

function requireAuth(config) {
  if (config?.apiKey) return;
  throw new McpBridgeError("未配置Wawapi API Key", {
    status: 401,
    code: "api_key_missing",
    nextActions: [
      "重新运行安装器并使用-ResetApiKey更新Key",
      "或在启动Codex前设置WAWAPI_API_KEY环境变量",
    ],
  });
}

function createApi(config, model = "gpt-image-2", overrides = {}) {
  requireAuth(config);
  return createImageApi({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model,
    preferAsyncImages: overrides.preferAsyncImages === true,
    catalogTimeoutMs: overrides.catalogTimeoutMs,
    catalogMaxRetries: overrides.catalogMaxRetries,
    catalogRetryDelayMs: overrides.catalogRetryDelayMs,
  }, overrides.fetchImpl);
}

async function discoverModels(config, overrides = {}) {
  const api = createApi(config, "gpt-image-2", overrides);
  const result = await api.listModels({
    includeMetadata: true,
    timeoutMs: overrides.catalogTimeoutMs,
    maxRetries: overrides.catalogMaxRetries,
    retryDelayMs: overrides.catalogRetryDelayMs,
  });
  return {
    ...createModelCatalog(result.models, "gpt-image-2"),
    probe: result.probe,
  };
}

function safeOrigin(baseUrl) {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

function serializeProbeError(error, config) {
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  return {
    code: error?.code || "endpoint_error",
    status: Number(error?.status) || 0,
    message: redactText(error?.message || "模型目录探测失败", [config.apiKey]),
    retryable: Boolean(error?.retryable),
    attempts: Number(error?.attempts) || 1,
    request_id: error?.requestId || null,
    phase: error?.phase || details.phase || "model_catalog",
    target_service: "wawapi",
    target_origin: safeOrigin(config.baseUrl),
    target_path: error?.target || details.target || "/models",
    network_category: error?.networkCategory || details.network_category || null,
    cause_code: error?.causeCode || details.cause_code || null,
    next_actions: Array.isArray(error?.nextActions) ? error.nextActions : [],
  };
}

function modelCatalogWarning(error, config, continued = false) {
  const probeError = serializeProbeError(error, config);
  probeError.next_actions = [];
  return {
    code: "model_catalog_unverified",
    message: continued
      ? "模型目录未能验证；本次已按内置能力证据继续用户授权的真实生成请求"
      : "模型目录未能验证；这不代表真实图片生成渠道不可用",
    probe_error: probeError,
    next_actions: [
      "若用户已经明确请求生成图片，可继续一次generate_image或edit_image调用",
      "仅把真实生成接口返回的upstream_channel_unavailable视为生图渠道不可用证据",
    ],
  };
}

async function doctor(config, overrides = {}) {
  const startedAt = Date.now();
  const runtimeVersion = String(overrides.nodeVersion || process.version);
  const runtimeMajor = Number.parseInt(runtimeVersion.replace(/^v/, "").split(".")[0], 10);
  const runtimeReady = Number.isInteger(runtimeMajor) && runtimeMajor >= 22;
  const checks = {
    runtime: {
      status: runtimeReady ? "ok" : "failed",
      node: runtimeVersion,
      required: ">=22",
      executable: process.execPath,
    },
    auth: {
      status: config.apiKeyPresent ? "configured" : "missing",
      source: config.authSource,
      masked: maskApiKey(config.apiKey),
    },
    endpoint: {
      status: "not_checked",
      verification: "not_probed",
      scope: "model_catalog_only",
      method: "GET",
      base_url: config.baseUrl,
      target_path: "/models",
      latency_ms: null,
      attempts: 0,
      http_status: null,
    },
  };
  let models = [];
  let modelMode = "unknown";
  let catalogStatus = "not_probed";
  const issues = [];
  const warnings = [];

  if (!runtimeReady) {
    issues.push({
      code: "runtime_unsupported",
      message: `当前Node.js运行时${runtimeVersion}低于要求的22`,
      retryable: false,
      next_actions: ["重新运行最新版install.cmd，让安装器配置受管Node.js运行时"],
    });
  }

  if (!config.apiKeyPresent) {
    issues.push({
      code: "api_key_missing",
      message: "未配置Wawapi API Key",
      retryable: false,
      next_actions: [
        "重新运行安装器并使用-ResetApiKey更新Key",
        "或在启动Codex前设置WAWAPI_API_KEY环境变量",
      ],
    });
  } else if (runtimeReady && overrides.probeCatalog !== false) {
    const endpointStartedAt = Date.now();
    try {
      const catalog = await discoverModels(config, overrides);
      models = catalog.models;
      modelMode = catalog.mode;
      checks.endpoint.status = "ok";
      checks.endpoint.verification = "verified";
      checks.endpoint.latency_ms = Date.now() - endpointStartedAt;
      checks.endpoint.attempts = catalog.probe?.attempts || 1;
      checks.endpoint.http_status = catalog.probe?.status || 200;
      catalogStatus = "verified";
    } catch (error) {
      checks.endpoint.latency_ms = Date.now() - endpointStartedAt;
      checks.endpoint.attempts = Number(error?.attempts) || 1;
      checks.endpoint.http_status = Number(error?.status) || 0;
      checks.endpoint.error = serializeProbeError(error, config);
      if (error?.code === "invalid_api_key") {
        checks.endpoint.status = "failed";
        checks.endpoint.verification = "failed";
        catalogStatus = "failed";
        issues.push(checks.endpoint.error);
      } else {
        checks.endpoint.status = "warning";
        checks.endpoint.verification = "unverified";
        catalogStatus = "unverified";
        warnings.push(modelCatalogWarning(error, config));
      }
    }
  } else if (config.apiKeyPresent && runtimeReady) {
    checks.endpoint.reason = "catalog_probe_disabled";
  }

  const ready = runtimeReady && checks.auth.status === "configured" && !issues.some((issue) => (
    issue.code === "invalid_api_key"
  ));
  if (!ready && issues.length === 0) {
    issues.push({
      code: "doctor_invariant_error",
      message: "Doctor未能确定阻断原因",
      retryable: false,
      next_actions: ["重新运行安装器；若仍出现此状态，请提交Doctor完整输出"],
    });
  }
  return successEnvelope("doctor", {
    ready,
    checks,
    models,
    model_mode: modelMode,
    catalog_status: catalogStatus,
    generation_channel_status: "not_probed",
    ready_meaning: "本地MCP具备尝试一次用户授权生图请求的条件；不保证上游生成渠道当前可用",
    config_file: config.configFile,
    default_output_dir: config.defaultOutputDir,
    elapsed_ms: Date.now() - startedAt,
    issues,
  }, warnings);
}

async function listModels(config, overrides = {}) {
  const catalog = await discoverModels(config, overrides);
  return successEnvelope("models list", {
    models: catalog.models,
    count: catalog.modelCount,
    mode: catalog.mode,
    default_model: catalog.defaultModel,
    active_model: catalog.activeModel,
    source: catalog.catalogSource,
  });
}

function normalizeGenerationOptions(options = {}) {
  const prompt = String(options.prompt || "").trim();
  if (!prompt) {
    throw new McpBridgeError("MCP参数prompt不能为空", {
      status: 400,
      code: "invalid_prompt",
    });
  }
  if (prompt.length > 32000) {
    throw new McpBridgeError("提示词不能超过32000个字符", {
      status: 400,
      code: "invalid_prompt",
    });
  }

  const outputFormat = normalizeFormat(options.format || "png");
  if (!VALID_FORMATS.has(outputFormat)) {
    throw new McpBridgeError("输出格式必须是png、jpeg或webp", {
      status: 400,
      code: "invalid_format",
    });
  }
  const quality = String(options.quality || "low").toLowerCase();
  if (!VALID_QUALITIES.has(quality)) {
    throw new McpBridgeError("质量必须是low、medium、high或auto", {
      status: 400,
      code: "invalid_quality",
    });
  }
  const count = Number.parseInt(options.count ?? options.n ?? 1, 10);
  if (!Number.isInteger(count) || count < 1 || count > 4) {
    throw new McpBridgeError("图片数量必须在1到4之间", {
      status: 400,
      code: "invalid_count",
    });
  }
  const timeoutMs = Number.parseInt(options.timeoutMs ?? 300000, 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30 * 60_000) {
    throw new McpBridgeError("超时必须在1000到1800000毫秒之间", {
      status: 400,
      code: "invalid_timeout",
    });
  }
  return {
    prompt,
    requestedModel: String(options.model || "auto").trim() || "auto",
    size: String(options.size || "1024x1024").trim(),
    quality,
    outputFormat,
    outputCompression: options.compression,
    background: String(options.background || "auto"),
    moderation: String(options.moderation || "auto"),
    count,
    timeoutMs,
    output: options.output || options.out || null,
    referencePath: options.referencePath || options.reference || null,
    preferAsyncImages: options.preferAsyncImages,
  };
}

async function resolveReferenceImage(referencePath) {
  if (!referencePath) return null;
  const absolutePath = path.resolve(referencePath);
  let buffer;
  try {
    buffer = await fsp.readFile(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      throw new McpBridgeError("找不到参考图文件", {
        status: 400,
        code: "reference_image_not_found",
        details: { path: absolutePath },
      });
    }
    throw new McpBridgeError("无法读取参考图文件", {
      status: 400,
      code: "reference_image_unreadable",
      details: { path: absolutePath, cause_code: error?.code || null },
    });
  }
  if (buffer.length > MAX_REFERENCE_IMAGE_BYTES) {
    throw new McpBridgeError("参考图不能超过10 MB", {
      status: 400,
      code: "reference_image_too_large",
    });
  }
  const inspected = inspectImage(buffer);
  if (!inspected) {
    throw new McpBridgeError("参考图必须是有效的PNG、JPEG或WebP文件", {
      status: 400,
      code: "invalid_reference_image",
    });
  }
  const mimeSubtype = inspected.format === "jpeg" ? "jpeg" : inspected.format;
  return {
    name: `${path.basename(absolutePath, path.extname(absolutePath))}${extensionForFormat(inspected.format)}`,
    dataUrl: `data:image/${mimeSubtype};base64,${buffer.toString("base64")}`,
    path: absolutePath,
    width: inspected.width,
    height: inspected.height,
    format: inspected.format,
    bytes: buffer.length,
  };
}

function markdownImage(absolutePath, alt = "generated image") {
  const normalized = path.resolve(absolutePath).replace(/\\/g, "/");
  const escapedAlt = String(alt).replace(/[\[\]]/g, "");
  return `![${escapedAlt}](<${normalized}>)`;
}

async function targetIsDirectory(rawTarget, target) {
  if (!rawTarget) return true;
  if (String(rawTarget).endsWith(path.sep) || String(rawTarget).endsWith("/")) return true;
  try {
    return (await fsp.stat(target)).isDirectory();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return !path.extname(target);
  }
}

async function uniqueDestination(candidate) {
  try {
    await fsp.access(candidate);
  } catch (error) {
    if (error.code === "ENOENT") return { path: candidate, adjusted: false };
    throw error;
  }
  const extension = path.extname(candidate);
  const stem = path.basename(candidate, extension);
  const directory = path.dirname(candidate);
  for (let suffix = 2; suffix <= 10000; suffix += 1) {
    const next = path.join(directory, `${stem}-${suffix}${extension}`);
    try {
      await fsp.access(next);
    } catch (error) {
      if (error.code === "ENOENT") return { path: next, adjusted: true };
      throw error;
    }
  }
  throw new McpBridgeError("无法找到可用的输出文件名", { code: "output_name_exhausted" });
}

async function atomicCopy(source, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temp = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fsp.copyFile(source, temp, fs.constants.COPYFILE_EXCL);
    await fsp.rename(temp, destination);
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
  }
}

async function inspectFile(filePath) {
  const absolutePath = path.resolve(filePath);
  let stat;
  try {
    stat = await fsp.stat(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      throw new McpBridgeError("找不到图片文件", {
        status: 400,
        code: "image_not_found",
        details: { path: absolutePath },
      });
    }
    throw new McpBridgeError("无法读取图片文件", {
      status: 400,
      code: "image_unreadable",
      details: { path: absolutePath, cause_code: error?.code || null },
    });
  }
  if (!stat.isFile()) {
    throw new McpBridgeError("目标不是文件", { status: 400, code: "not_a_file" });
  }
  if (stat.size > 100 * 1024 * 1024) {
    throw new McpBridgeError("图片文件超过100 MB检查限制", {
      status: 400,
      code: "image_too_large_to_inspect",
    });
  }
  const buffer = await fsp.readFile(absolutePath);
  const inspected = inspectImage(buffer);
  if (!inspected) {
    throw new McpBridgeError("文件不是有效的PNG、JPEG或WebP图片", {
      status: 400,
      code: "invalid_image_file",
    });
  }
  return {
    path: absolutePath,
    file_uri: pathToFileURL(absolutePath).href,
    markdown: markdownImage(absolutePath),
    filename: path.basename(absolutePath),
    bytes: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    width: inspected.width,
    height: inspected.height,
    size: `${inspected.width}x${inspected.height}`,
    format: normalizeFormat(inspected.format),
  };
}

async function copyGeneratedImages(entry, stagingOutputDir, rawTarget) {
  const requestedTarget = path.resolve(rawTarget);
  const treatAsDirectory = await targetIsDirectory(rawTarget, requestedTarget);
  const requestedExtension = path.extname(requestedTarget);
  const requestedFileFormat = formatForExtension(requestedExtension);
  const results = [];

  for (let index = 0; index < entry.images.length; index += 1) {
    const image = entry.images[index];
    const source = path.join(stagingOutputDir, image.filename);
    const actualFormat = normalizeFormat(image.format);
    const actualExtension = extensionForFormat(actualFormat);
    let candidate;
    let extensionAdjusted = false;

    if (treatAsDirectory) {
      candidate = path.join(requestedTarget, image.filename);
    } else {
      extensionAdjusted = Boolean(requestedFileFormat && requestedFileFormat !== actualFormat);
      const destinationExtension = extensionAdjusted ? actualExtension : requestedExtension || actualExtension;
      const suffix = entry.images.length > 1 ? `-${index + 1}` : "";
      candidate = path.join(
        path.dirname(requestedTarget),
        `${path.basename(requestedTarget, requestedExtension)}${suffix}${destinationExtension}`,
      );
    }

    const unique = await uniqueDestination(candidate);
    await atomicCopy(source, unique.path);
    results.push({
      ...(await inspectFile(unique.path)),
      requested_path: treatAsDirectory ? null : requestedTarget,
      output_extension_adjusted: extensionAdjusted,
      output_collision_adjusted: unique.adjusted,
    });
  }
  return results;
}

function compareOutput(request, images) {
  const deviations = [];
  const requestedSize = request.size;
  const requestedFormat = normalizeFormat(request.outputFormat);
  if (request.count !== images.length) {
    deviations.push({
      code: "count_mismatch",
      requested: request.count,
      actual: images.length,
    });
  }
  for (const image of images) {
    if (requestedSize !== "auto" && requestedSize !== image.size) {
      const errorPercent = ratioErrorPercent(requestedSize, image.size);
      deviations.push({
        code: "size_mismatch",
        image: image.path,
        requested: requestedSize,
        actual: image.size,
        aspect_status: aspectStatus(requestedSize, image.size),
        aspect_ratio_error_percent: errorPercent === null ? null : Number(errorPercent.toFixed(4)),
      });
    }
    if (requestedFormat !== image.format) {
      deviations.push({
        code: "format_mismatch",
        image: image.path,
        requested: requestedFormat,
        actual: image.format,
      });
    }
  }
  return {
    matches_request: deviations.length === 0,
    status: deviations.length ? "degraded" : "exact",
    deviations,
  };
}

async function generateImage(config, rawOptions = {}, overrides = {}) {
  requireAuth(config);
  const options = normalizeGenerationOptions(rawOptions);
  const referenceImage = await resolveReferenceImage(options.referencePath);
  const warnings = [];
  let catalog;
  let catalogStatus = "verified";
  try {
    catalog = await discoverModels(config, overrides);
  } catch (error) {
    if (error.code === "invalid_api_key") {
      throw error;
    }
    catalogStatus = "unverified";
    if (options.requestedModel === "auto") {
      catalog = createModelCatalog(KNOWN_MODELS, "gpt-image-2");
    } else {
      catalog = { models: [], mode: "unknown", catalogSource: "unavailable" };
    }
    warnings.push(modelCatalogWarning(error, config, true));
  }

  const selection = selectModel({
    models: catalog.models,
    requestedModel: options.requestedModel,
    size: options.size,
    hasReferenceImage: Boolean(referenceImage),
  });
  if (options.requestedModel !== "auto" && catalog.models.length && !selection.available) {
    throw new McpBridgeError(`模型${selection.model}不在当前上游目录中`, {
      status: 400,
      code: "model_unavailable",
      details: { available_models: catalog.models },
      nextActions: ["调用list_image_models查看当前模型", "省略model参数让MCP自动选择"],
    });
  }

  const capability = explainCapability({
    models: catalog.models,
    model: options.requestedModel,
    size: options.size,
    format: options.outputFormat,
    count: options.count,
    hasReferenceImage: Boolean(referenceImage),
  });
  const api = createApi(config, selection.model, {
    ...overrides,
    preferAsyncImages: options.preferAsyncImages,
  });
  const stagingRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "wawapi-image-mcp-"));
  const storage = createStorage(stagingRoot, overrides.storageOptions);
  const startedAt = Date.now();

  try {
    const apiOptions = {
      prompt: options.prompt,
      model: selection.model,
      size: options.size,
      quality: options.quality,
      outputFormat: options.outputFormat,
      outputCompression: options.outputCompression,
      background: options.background,
      moderation: options.moderation,
      n: options.count,
      timeoutMs: options.timeoutMs,
      referenceImage,
    };
    const apiResult = referenceImage ? await api.edit(apiOptions) : await api.generate(apiOptions);
    const elapsedMs = Date.now() - startedAt;
    const entry = await storage.saveGeneration(apiResult, {
      ...apiOptions,
      elapsedMs,
      hasReferenceImage: Boolean(referenceImage),
    });
    const outputTarget = path.resolve(options.output || config.defaultOutputDir);
    const images = await copyGeneratedImages(entry, storage.outputDir, outputTarget);
    const comparison = compareOutput({
      size: options.size,
      outputFormat: options.outputFormat,
      count: options.count,
    }, images);
    if (!comparison.matches_request) {
      warnings.push({
        code: "provider_output_degraded",
        message: "上游返回结果与请求参数不完全一致；请以实际像素、格式和数量为准",
        deviations: comparison.deviations,
      });
    }

    return successEnvelope(referenceImage ? "edit" : "generate", {
      request: {
        model: selection.model,
        model_requested: options.requestedModel,
        model_selection_reason: selection.reason,
        size: options.size,
        quality: options.quality,
        format: options.outputFormat,
        count: options.count,
        has_reference_image: Boolean(referenceImage),
        prompt_sha256: crypto.createHash("sha256").update(options.prompt).digest("hex"),
      },
      result: {
        status: comparison.status,
        matches_request: comparison.matches_request,
        actual_count: images.length,
        deviations: comparison.deviations,
        images,
      },
      provider: {
        base_url: config.baseUrl,
        model_catalog_status: catalogStatus,
        transport: apiResult.transport || "sync",
        task_id: apiResult.taskId || null,
        poll_count: apiResult.pollCount || 0,
        attempts: apiResult.attempts || 1,
        elapsed_ms: elapsedMs,
        usage: apiResult.usage || null,
      },
      capability,
    }, warnings);
  } catch (error) {
    if (
      referenceImage &&
      Number(error.status) === 400 &&
      /prompt\s+is\s+required/i.test(String(error.message || ""))
    ) {
      error.code = "reference_request_misparsed";
      error.message = "上游未正确解析参考图Multipart请求：本地已发送非空prompt，但模型路由仍报告prompt缺失";
      error.details = {
        upstream_type: error.details || null,
        model: selection.model,
        prompt_was_sent: true,
      };
      error.nextActions = selection.model === "gpt-image-2"
        ? ["将其视为上游参考图路由异常，稍后再试", "不要反复改写已经非空的提示词"]
        : ["改用gpt-image-2基础模型", "若基础模型也返回502/503，则等待上游恢复"];
    } else if (error.code === "invalid_api_key") {
      error.nextActions = error.nextActions?.length ? error.nextActions : [
        "重新运行安装器并使用-ResetApiKey更新Key",
        "若Key由第三方提供，请确认Key仍有效且已开通图片服务",
      ];
    } else if (error.code === "upstream_channel_unavailable") {
      error.nextActions = error.nextActions?.length ? error.nextActions : [
        "等待上游图片渠道恢复后再试",
        "联系API Key提供方，确认该Key已开通且当前有可用图片渠道",
        "不要通过修改提示词、尺寸或模型来规避此错误",
      ];
    } else if (error.code === "unsupported_size") {
      error.nextActions = [
        "改用1024x1024",
        "调用explain_image_capability查看该尺寸的实测边界",
      ];
    } else if ([502, 503, 524].includes(Number(error.status))) {
      error.nextActions = [
        "将本次视为上游瞬时状态，不要据此判定模型永久不支持",
        "不要自动重复付费请求；由用户决定是否稍后重试",
      ];
    }
    throw error;
  } finally {
    await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function inspectImageFile(filePath) {
  return successEnvelope("inspect", await inspectFile(filePath));
}

async function explain(config, options = {}, overrides = {}) {
  let models = Array.isArray(options.models) && options.models.length ? options.models : KNOWN_MODELS;
  let modelSource = "baseline";
  const warnings = [];
  if (!options.offline && config?.apiKeyPresent) {
    try {
      const catalog = await discoverModels(config, overrides);
      models = catalog.models;
      modelSource = "upstream";
    } catch (error) {
      warnings.push(modelCatalogWarning(error, config));
    }
  }
  return successEnvelope("capabilities explain", {
    model_source: modelSource,
    selection_scope: modelSource === "upstream" ? "current_catalog" : "bundled_baseline",
    available_models: models,
    explanation: explainCapability({
      models,
      model: options.model || "auto",
      size: options.size || "1024x1024",
      format: options.format || "png",
      count: options.count || 1,
      hasReferenceImage: Boolean(options.hasReferenceImage || options.reference),
    }),
  }, warnings);
}

module.exports = {
  McpBridgeError,
  KNOWN_MODELS,
  SCHEMA_VERSION,
  compareOutput,
  doctor,
  errorEnvelope,
  explain,
  generateImage,
  inspectFile,
  inspectImageFile,
  listModels,
  markdownImage,
  normalizeFormat,
  redactText,
  successEnvelope,
};
