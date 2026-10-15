// Protocol adapters keep provider-specific wire formats out of the MCP bridge.
// They never perform network calls, choose another model, or submit extra jobs.
function protocolError(message, code = "unsupported_parameter") {
  return Object.assign(new Error(message), { code, status: 400, retryable: false });
}

function imageDataUrl(value) {
  if (typeof value !== "string") return null;
  const match = /^data:image\/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(value);
  return match ? { b64_json: match[1] } : /^https?:\/\//i.test(value) ? { url: value } : null;
}

function buildContentRequest(format, options, extraBody = {}) {
  if ((options.n ?? 1) !== 1) {
    throw protocolError(`${format}适配器每次只提交一个请求，count必须为1；不会循环计费生成`, "unsupported_count");
  }
  for (const key of ["quality", "outputCompression", "background", "moderation", "responseFormat"]) {
    if (options[key] !== undefined && options[key] !== "auto") {
      throw protocolError(`${format}不接受通用参数${key}；请使用供应商extra_body配置`);
    }
  }
  const size = options.size;
  if (size && size !== "auto") {
    throw protocolError(`${format}不接受精确像素size；使用size=auto并在extra_body中配置供应商比例或分辨率`);
  }
  if (options.outputFormat && options.outputFormat !== "auto") {
    throw protocolError(`${format}不保证指定输出格式；请使用format=auto并检查实际文件格式`);
  }
  if (format === "gemini") {
    const parts = [{ text: options.prompt }];
    if (options.referenceImage) {
      const match = /^data:([^;]+);base64,(.+)$/s.exec(options.referenceImage.dataUrl);
      parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
    return {
      ...extraBody,
      contents: [{ role: "user", parts }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...extraBody.generationConfig, candidateCount: 1 },
    };
  }
  const content = [{ type: "text", text: options.prompt }];
  if (options.referenceImage) content.push({ type: "image_url", image_url: { url: options.referenceImage.dataUrl } });
  return {
    modalities: ["image", "text"],
    ...extraBody,
    model: options.model,
    messages: [{ role: "user", content }],
    stream: false,
    n: 1,
  };
}

function normalizeContentResponse(format, body) {
  const data = [];
  if (format === "gemini") {
    for (const candidate of body?.candidates || []) {
      for (const part of candidate.content?.parts || []) {
        const inline = part.inlineData || part.inline_data;
        if (!part.thought && inline?.data && /^image\/(png|jpeg|webp)$/i.test(inline.mimeType || inline.mime_type || "")) {
          data.push({ b64_json: inline.data });
        }
      }
    }
    return { data, usage: body?.usageMetadata || null };
  }
  for (const choice of body?.choices || []) {
    const message = choice.message || {};
    for (const item of message.images || []) {
      const image = imageDataUrl(item.image_url?.url || item.url);
      if (image) data.push(image);
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        const image = imageDataUrl(part.image_url?.url || (part.type === "image" ? part.url : null));
        if (image) data.push(image);
      }
    }
    // Some compatible gateways emit Markdown instead of structured image parts.
    // Only explicit image links are accepted; arbitrary links/text are not fetched.
    if (!data.length && typeof message.content === "string") {
      for (const match of message.content.matchAll(/!\[[^\]]*\]\(<?([^\s<>]+?)>?\)/g)) {
        const image = imageDataUrl(match[1]);
        if (image) data.push(image);
      }
    }
  }
  return { data, usage: body?.usage || null };
}

function mergeImagePayload(payload, config, edit = false) {
  const supplied = { ...payload };
  for (const key of ["size", "output_format"]) {
    if (supplied[key] === "auto") delete supplied[key];
  }
  const merged = { ...config.extraBody, ...supplied };
  const model = String(payload.model);
  if (/^dall-e-/i.test(model)) {
    for (const key of ["output_format", "output_compression", "background", "moderation"]) {
      if (merged[key] !== undefined) throw protocolError(`${model}不接受${key}；省略该参数后重试`);
    }
    if (model === "dall-e-3" && (edit || payload.n > 1)) {
      throw protocolError("dall-e-3仅接受单张文生图，不支持编辑", "unsupported_operation");
    }
  }
  for (const key of config.omitFields || []) delete merged[key];
  return merged;
}

module.exports = { buildContentRequest, normalizeContentResponse, mergeImagePayload, imageDataUrl };
