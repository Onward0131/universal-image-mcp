class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.status = options.status || 0;
    this.requestId = options.requestId || null;
    this.code = options.code || null;
    this.details = options.details || null;
    this.attempts = options.attempts || 1;
    this.retryable = Boolean(options.retryable);
    this.nextActions = Array.isArray(options.nextActions) ? options.nextActions : [];
    this.phase = options.phase || null;
    this.target = options.target || null;
    this.networkCategory = options.networkCategory || null;
    this.causeCode = options.causeCode || null;
  }
}

class InputError extends ApiError {
  constructor(message, code = "invalid_request") {
    super(message, { status: 400, code, retryable: false });
    this.name = "InputError";
  }
}

const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;

function errorChain(error) {
  const chain = [];
  const visited = new Set();
  let current = error;
  while (current && typeof current === "object" && !visited.has(current) && chain.length < 8) {
    chain.push(current);
    visited.add(current);
    current = current.cause;
  }
  return chain;
}

function classifyNetworkError(error) {
  const chain = errorChain(error);
  const causeCode = chain
    .map((item) => item?.code)
    .find((value) => typeof value === "string" && value.trim()) || null;
  const causeName = chain
    .map((item) => item?.name)
    .find((value) => typeof value === "string" && value.trim()) || null;
  const text = chain
    .flatMap((item) => [item?.code, item?.name, item?.message])
    .filter(Boolean)
    .join(" ");

  let category = "unknown";
  if (/ENOTFOUND|EAI_AGAIN|EAI_FAIL|ENODATA|dns/i.test(text)) {
    category = "dns_resolution";
  } else if (/ECONNREFUSED|connection refused/i.test(text)) {
    category = "connection_refused";
  } else if (/ECONNRESET|EPIPE|connection reset|socket hang up/i.test(text)) {
    category = "connection_reset";
  } else if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|connect timeout/i.test(text)) {
    category = "connection_timeout";
  } else if (
    /CERT_|ERR_TLS_|ERR_SSL|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|certificate|tls|ssl/i.test(text)
  ) {
    category = "tls_certificate";
  } else if (/ERR_PROXY|proxy|tunnel/i.test(text)) {
    category = "proxy_connection";
  } else if (/ENETUNREACH|EHOSTUNREACH|network is unreachable|host is unreachable/i.test(text)) {
    category = "network_unreachable";
  } else if (/UND_ERR_SOCKET|socket/i.test(text)) {
    category = "socket_failure";
  }

  return { category, causeCode, causeName };
}

function requestPhase(pathname, method = "GET") {
  if (pathname === "/models") return "model_catalog";
  if (pathname.startsWith("/images/tasks/")) return "generation_poll";
  if (pathname.startsWith("/images/edits")) return "edit_submit";
  if (pathname.startsWith("/images/generations")) return "generation_submit";
  return String(method).toUpperCase() === "GET" ? "read_only_request" : "provider_request";
}

function phaseLabel(phase) {
  return {
    model_catalog: "模型目录探测",
    generation_poll: "图片任务状态查询",
    edit_submit: "参考图生成请求",
    generation_submit: "图片生成请求",
    read_only_request: "只读上游请求",
    provider_request: "上游请求",
  }[phase] || "上游请求";
}

function networkNextActions(category) {
  const shared = ["不要把网络探测失败直接解释为图片生成渠道不可用"];
  const actions = {
    dns_resolution: ["检查DNS解析、代理或企业网络策略是否允许访问wawapii.com"],
    connection_refused: ["检查代理、防火墙或安全软件是否拒绝到wawapii.com的HTTPS连接"],
    connection_reset: ["检查代理、VPN或企业网关是否中途重置HTTPS连接"],
    connection_timeout: ["检查网络、代理和防火墙；稍后再执行只读探测"],
    tls_certificate: ["检查系统时间、证书链和HTTPS代理证书配置"],
    proxy_connection: ["检查HTTP(S)代理地址、凭据和代理连通性"],
    network_unreachable: ["检查当前网络连接、路由、VPN和防火墙"],
    socket_failure: ["检查代理、VPN和本机安全软件的网络拦截记录"],
    unknown: ["检查网络、代理、DNS、防火墙和系统时间"],
  };
  return [...(actions[category] || actions.unknown), ...shared];
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAfterMilliseconds(headers, fallbackMs = 3000) {
  const value = headers?.get?.("retry-after");
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(30_000, Math.max(0, date - Date.now()));
  return fallbackMs;
}

function extractErrorMessage(body, status) {
  if (body && typeof body === "object") {
    return (
      body.error?.message ||
      body.message ||
      body.error?.code ||
      `API request failed with HTTP ${status}`
    );
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 500);
  return `API request failed with HTTP ${status}`;
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

function isInvalidApiKeyError(status, message, code) {
  if (status === 401) return true;
  const text = `${code || ""} ${message || ""}`;
  return matchesAny(text, [
    /invalid[_\s-]*(?:api[_\s-]*)?key/i,
    /incorrect[_\s-]*(?:api[_\s-]*)?key/i,
    /api\s*key.{0,24}(?:invalid|expired|disabled|revoked)/i,
    /unauthori[sz]ed/i,
    /authentication\s+(?:failed|required)/i,
    /(?:api\s*key|密钥|令牌).{0,16}(?:无效|错误|过期|禁用|吊销)/i,
    /(?:鉴权|认证|授权)(?:失败|无效|错误)/i,
  ]);
}

function isUpstreamChannelUnavailable(message, code) {
  const text = `${code || ""} ${message || ""}`;
  return matchesAny(text, [
    /no[_\s-]+available[_\s-]+compatible[_\s-]+accounts?/i,
    /no[_\s-]+available[_\s-]+(?:image[_\s-]+)?channels?/i,
    /channels?[_\s-]+(?:is[_\s-]+|are[_\s-]+)?unavailable/i,
    /upstream[_\s-]+capacity/i,
    /(?:无|没有|暂无)可用(?:的)?(?:图片|图像|生图)?(?:渠道|通道|兼容账号)/,
    /(?:渠道|通道)(?:当前|暂时|暂无)?不可用/,
    /无可用兼容账号/,
  ]);
}

function createHttpError(body, response, attempts, context = {}) {
  const upstreamMessage = extractErrorMessage(body, response.status);
  const normalizedMessage = upstreamMessage.toLowerCase();
  const upstreamCode = body?.error?.code || body?.code || null;
  let code = upstreamCode;
  let message = upstreamMessage;
  let retryable = false;
  let nextActions = [];

  if (isInvalidApiKeyError(response.status, upstreamMessage, upstreamCode)) {
    code = "invalid_api_key";
    message = "Wawapi API Key无效、已过期或未通过鉴权";
    nextActions = [
      "重新运行安装器并使用-ResetApiKey更新Key",
      "若Key由第三方提供，请确认Key仍有效且已开通图片服务",
    ];
  } else if (isUpstreamChannelUnavailable(upstreamMessage, upstreamCode)) {
    code = "upstream_channel_unavailable";
    message = "API Key已被接收，但上游当前没有可用的图片生成渠道";
    retryable = true;
    nextActions = [
      "等待上游图片渠道恢复后再试",
      "联系API Key提供方，确认该Key已开通且当前有可用图片渠道",
      "不要通过修改提示词、尺寸或模型来规避此错误",
    ];
  } else if (response.status === 524) {
    code = "upstream_timeout";
    message = "上游图片生成等待超时（HTTP 524）";
    retryable = true;
    nextActions = [
      "将本次视为上游瞬时超时，稍后再试",
      "不要自动重放可能已经开始计费的请求",
    ];
  } else if (response.status === 429) {
    code = "rate_limit";
    message = "图片服务当前请求过多，请稍后重试";
    retryable = true;
    nextActions = ["等待限流窗口结束后再试", "不要连续提交多个生成请求"];
  } else if (
    [400, 422].includes(response.status) &&
    (
      ["invalid_size", "unsupported_size"].includes(String(code || "").toLowerCase()) ||
      (normalizedMessage.includes("size") && /invalid|unsupported|must be|not support|not allowed/.test(normalizedMessage))
    )
  ) {
    code = "unsupported_size";
    message = "上游不支持请求的图片尺寸";
    nextActions = ["改用1024x1024", "调用explain_image_capability查看该尺寸的实测边界"];
  } else if (response.status >= 500) {
    code = "upstream_error";
    retryable = true;
    nextActions = [
      "将本次视为上游瞬时故障，稍后再试",
      "不要自动重放可能已经开始计费的请求",
    ];
  } else {
    code ||= "provider_error";
  }

  return new ApiError(message, {
    status: response.status,
    requestId:
      response.headers.get("x-request-id") ||
      response.headers.get("request-id") ||
      body?.error?.request_id,
    code,
    details: {
      upstream_type: body?.error?.type || null,
      phase: context.phase || null,
      target: context.target || null,
    },
    attempts,
    retryable,
    nextActions,
    phase: context.phase,
    target: context.target,
  });
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildGenerationPayload(options) {
  const prompt = String(options.prompt || "").trim();
  if (!prompt) throw new InputError("提示词不能为空", "invalid_prompt");
  if (prompt.length > 32000) throw new InputError("提示词不能超过32000个字符", "invalid_prompt");

  const n = Number.parseInt(options.n ?? 1, 10);
  if (!Number.isInteger(n) || n < 1 || n > 4) {
    throw new InputError("图片数量必须在1到4之间", "invalid_count");
  }

  const payload = {
    model: String(options.model || "gpt-image-2").trim(),
    prompt,
    n,
  };

  const optionalText = [
    ["size", options.size],
    ["quality", options.quality],
    ["output_format", options.outputFormat],
    ["background", options.background],
    ["moderation", options.moderation],
  ];
  for (const [key, value] of optionalText) {
    if (value !== undefined && value !== null && String(value).trim()) {
      payload[key] = String(value).trim();
    }
  }

  if (
    ["jpeg", "webp"].includes(payload.output_format) &&
    options.outputCompression !== undefined
  ) {
    const compression = Number.parseInt(options.outputCompression, 10);
    if (!Number.isInteger(compression) || compression < 0 || compression > 100) {
      throw new InputError("输出压缩率必须在0到100之间", "invalid_compression");
    }
    payload.output_compression = compression;
  }

  return payload;
}

function decodeReferenceImage(referenceImage) {
  const dataUrl = String(referenceImage?.dataUrl || "");
  const match = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw new InputError("参考图必须是PNG、JPEG或WebP文件", "invalid_reference_image");

  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length < 16) throw new InputError("参考图为空或已损坏", "invalid_reference_image");
  if (buffer.length > MAX_REFERENCE_IMAGE_BYTES) {
    throw new InputError("参考图不能超过10 MB", "reference_image_too_large");
  }

  const subtype = match[1] === "jpg" ? "jpeg" : match[1];
  const detectedSubtype = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ? "png"
    : buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
      ? "jpeg"
      : buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP"
        ? "webp"
        : null;
  if (!detectedSubtype || detectedSubtype !== subtype) {
    throw new InputError("参考图内容与文件格式不匹配或已损坏", "invalid_reference_image");
  }

  const extension = subtype === "jpeg" ? "jpg" : subtype;
  const providedName = String(referenceImage?.name || "reference").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  const filename = `${providedName.replace(/\.[^.]*$/, "") || "reference"}.${extension}`;
  return { buffer, filename, mimeType: `image/${subtype}` };
}

function parseImageResult(body, headers) {
  if (!Array.isArray(body?.data) || body.data.length === 0) {
    throw new ApiError("The API returned no image data", {
      requestId: headers.get("x-request-id") || null,
      code: "empty_image_response",
    });
  }

  const images = body.data.map((item, index) => {
    if (item?.b64_json) return { type: "base64", value: item.b64_json, index };
    if (item?.url) return { type: "url", value: item.url, index };
    throw new ApiError(`Image ${index + 1} has no b64_json or url field`, {
      code: "invalid_image_response",
    });
  });

  return {
    images,
    created: body.created || Math.floor(Date.now() / 1000),
    usage: body.usage || null,
    revisedPrompt: body.data[0]?.revised_prompt || null,
  };
}

function createImageApi(config, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");
  let asyncImageSupport = null;

  async function request(pathname, options = {}) {
    const timeoutMs = options.timeoutMs || 180000;
    const maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : 0;
    const shouldRetry = typeof options.shouldRetry === "function"
      ? options.shouldRetry
      : (error) => error.retryable;
    const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 1500;
    const phase = options.phase || requestPhase(pathname, options.method || "GET");
    const target = pathname;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const hasJsonBody = options.body !== undefined;
        const response = await fetchImpl(`${config.baseUrl}${pathname}`, {
          method: options.method || "GET",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            Accept: "application/json",
            ...(hasJsonBody ? { "Content-Type": "application/json" } : {}),
            ...options.headers,
          },
          body: options.formData || (hasJsonBody ? JSON.stringify(options.body) : undefined),
          signal: controller.signal,
        });

        const body = await readResponseBody(response);
        if (!response.ok) throw createHttpError(body, response, attempt, { phase, target });
        return { body, headers: response.headers, status: response.status, attempts: attempt };
      } catch (error) {
        let normalized = error;
        if (error.name === "AbortError") {
          normalized = new ApiError(
            `${phaseLabel(phase)}超过${Math.round(timeoutMs / 1000)}秒，本次请求已停止等待`,
            {
              code: "upstream_timeout",
              attempts: attempt,
              retryable: true,
              phase,
              target,
              networkCategory: "timeout",
              causeCode: error.code || error.cause?.code || "ABORT_ERR",
              details: {
                phase,
                target,
                network_category: "timeout",
                cause_code: error.code || error.cause?.code || "ABORT_ERR",
              },
            },
          );
        } else if (!(error instanceof ApiError)) {
          const classified = classifyNetworkError(error);
          normalized = new ApiError(`${phaseLabel(phase)}无法连接上游服务（${classified.category}）`, {
            code: "network_error",
            attempts: attempt,
            retryable: true,
            phase,
            target,
            networkCategory: classified.category,
            causeCode: classified.causeCode,
            details: {
              phase,
              target,
              network_category: classified.category,
              cause_code: classified.causeCode,
              cause_name: classified.causeName,
            },
            nextActions: networkNextActions(classified.category),
          });
        }

        normalized.phase ||= phase;
        normalized.target ||= target;

        normalized.attempts = attempt;
        if (normalized.retryable && shouldRetry(normalized) && attempt <= maxRetries) {
          await delay(Math.min(5000, retryDelayMs * attempt));
          continue;
        }
        throw normalized;
      } finally {
        clearTimeout(timer);
      }
    }

    throw new ApiError("Image request failed", { code: "request_failed" });
  }

  async function submitAndPollAsync(pathname, requestOptions, taskOptions = {}) {
    if (config.preferAsyncImages === false || asyncImageSupport === false) return null;

    let submission;
    try {
      submission = await request(`${pathname}/async`, {
        ...requestOptions,
        timeoutMs: taskOptions.submitTimeoutMs || 45_000,
        maxRetries: 1,
        shouldRetry: (error) => ["upstream_channel_unavailable", "rate_limit"].includes(error.code),
      });
    } catch (error) {
      const unavailable = error.status === 404 && (
        error.code === "not_found_error" ||
        String(error.message).toLowerCase().includes("async image tasks are not enabled")
      );
      if (!unavailable) throw error;
      asyncImageSupport = false;
      return null;
    }

    const taskId = String(submission.body?.task_id || submission.body?.id || "");
    if (!taskId || !/^imgtask_[A-Za-z0-9_-]+$/.test(taskId)) {
      throw new ApiError("异步生图接口未返回有效任务编号", {
        status: 502,
        code: "invalid_async_task",
      });
    }

    asyncImageSupport = true;
    const taskTimeoutMs = taskOptions.taskTimeoutMs || 30 * 60_000;
    const deadline = Date.now() + taskTimeoutMs;
    let pollDelayMs = Number.isFinite(taskOptions.pollIntervalMs)
      ? Math.max(0, taskOptions.pollIntervalMs)
      : retryAfterMilliseconds(submission.headers);
    let pollCount = 0;

    while (Date.now() <= deadline) {
      if (pollDelayMs > 0) await delay(pollDelayMs);
      const polled = await request(`/images/tasks/${encodeURIComponent(taskId)}`, {
        timeoutMs: taskOptions.pollTimeoutMs || 30_000,
        maxRetries: 2,
      });
      pollCount += 1;
      const task = polled.body || {};
      const status = String(task.status || "").toLowerCase();

      if (status === "completed") {
        if (!task.result) {
          throw new ApiError("异步生图任务已完成，但没有返回图片结果", {
            status: 502,
            code: "empty_async_result",
          });
        }
        return {
          ...parseImageResult(task.result, polled.headers),
          attempts: 1,
          transport: "async",
          taskId,
          pollCount,
        };
      }

      if (["failed", "expired", "cancelled", "canceled"].includes(status)) {
        const failureStatus = Number.isInteger(task.http_status) && task.http_status >= 400
          ? task.http_status
          : 502;
        const response = new Response(null, { status: failureStatus, headers: polled.headers });
        const error = createHttpError({ error: task.error || {} }, response, 1, {
          phase: "generation_poll",
          target: `/images/tasks/${encodeURIComponent(taskId)}`,
        });
        error.code ||= status === "failed" ? "async_task_failed" : `async_task_${status}`;
        throw error;
      }

      if (!["processing", "queued", "pending"].includes(status)) {
        throw new ApiError(`异步生图任务返回未知状态：${status || "empty"}`, {
          status: 502,
          code: "invalid_async_status",
        });
      }
      pollDelayMs = Number.isFinite(taskOptions.pollIntervalMs)
        ? Math.max(0, taskOptions.pollIntervalMs)
        : retryAfterMilliseconds(polled.headers);
    }

    throw new ApiError(`异步生图任务超过${Math.round(taskTimeoutMs / 60_000)}分钟，已停止等待`, {
      code: "upstream_timeout",
      retryable: true,
    });
  }

  return {
    async listModels(options = {}) {
      const response = await request("/models", {
        timeoutMs: options.timeoutMs ?? config.catalogTimeoutMs ?? 8000,
        maxRetries: options.maxRetries ?? config.catalogMaxRetries ?? 1,
        retryDelayMs: options.retryDelayMs ?? config.catalogRetryDelayMs ?? 250,
        shouldRetry: (error) => [
          "network_error",
          "upstream_timeout",
          "upstream_error",
          "upstream_channel_unavailable",
          "rate_limit",
        ].includes(error.code),
      });
      const { body } = response;
      const models = Array.isArray(body?.data)
        ? body.data.map((item) => item?.id).filter(Boolean)
        : [];
      if (options.includeMetadata) {
        return {
          models,
          probe: {
            phase: "model_catalog",
            target: "/models",
            status: response.status,
            attempts: response.attempts,
          },
        };
      }
      return models;
    },

    async generate(options) {
      const payload = buildGenerationPayload({ model: config.model, ...options });
      const asyncResult = await submitAndPollAsync(
        "/images/generations",
        { method: "POST", body: payload },
        options,
      );
      if (asyncResult) return asyncResult;
      const { body, headers, attempts } = await request("/images/generations", {
        method: "POST",
        body: payload,
        timeoutMs: options.timeoutMs || 300000,
        maxRetries: options.maxRetries ?? 1,
        retryDelayMs: options.retryDelayMs,
        shouldRetry: (error) => ["upstream_channel_unavailable", "rate_limit"].includes(error.code),
      });

      return { ...parseImageResult(body, headers), attempts, transport: "sync" };
    },

    async edit(options) {
      const payload = buildGenerationPayload({ model: config.model, ...options });
      const reference = decodeReferenceImage(options.referenceImage);
      const formData = new FormData();
      const orderedFields = ["prompt", "model", "n", "size", "quality", "output_format", "background", "moderation", "output_compression"];
      for (const key of orderedFields) {
        const value = payload[key];
        if (value === undefined) continue;
        formData.append(key, String(value));
      }
      formData.append("image", new Blob([reference.buffer], { type: reference.mimeType }), reference.filename);

      const asyncResult = await submitAndPollAsync(
        "/images/edits",
        { method: "POST", formData },
        options,
      );
      if (asyncResult) return asyncResult;

      const { body, headers, attempts } = await request("/images/edits", {
        method: "POST",
        formData,
        timeoutMs: options.timeoutMs || 300000,
        maxRetries: options.maxRetries ?? 1,
        retryDelayMs: options.retryDelayMs,
        shouldRetry: (error) => ["upstream_channel_unavailable", "rate_limit"].includes(error.code),
      });
      return { ...parseImageResult(body, headers), attempts, transport: "sync" };
    },

    capabilities() {
      return { asyncImages: asyncImageSupport };
    },
  };
}

module.exports = {
  ApiError,
  InputError,
  MAX_REFERENCE_IMAGE_BYTES,
  buildGenerationPayload,
  createImageApi,
  decodeReferenceImage,
  extractErrorMessage,
  classifyNetworkError,
  isInvalidApiKeyError,
  isUpstreamChannelUnavailable,
};
