const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const dns = require("node:dns").promises;
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");

const VALID_FORMATS = new Set(["png", "jpeg", "jpg", "webp"]);
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_IMAGE_DIMENSION = 100_000;

function storageError(message, code, status = 502) {
  const error = new Error(message);
  error.name = "StorageError";
  error.status = status;
  error.code = code;
  return error;
}

function extensionFor(format) {
  const normalized = String(format || "png").toLowerCase();
  if (!VALID_FORMATS.has(normalized)) return "png";
  return normalized === "jpeg" ? "jpg" : normalized;
}

function formatFromContentType(contentType) {
  const value = String(contentType || "").toLowerCase();
  if (value.includes("webp")) return "webp";
  if (value.includes("jpeg") || value.includes("jpg")) return "jpg";
  return "png";
}

function decodeBase64(value) {
  const compact = String(value || "").replace(/\s/g, "");
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    return null;
  }
  try {
    const buffer = Buffer.from(compact, "base64");
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

function decodeDataUrl(value) {
  const match = String(value).match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/s);
  if (!match) return null;
  const buffer = decodeBase64(match[2]);
  if (!buffer) return null;
  return { buffer, extension: extensionFor(match[1]) };
}

function validDimensions(width, height) {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_IMAGE_DIMENSION &&
    height <= MAX_IMAGE_DIMENSION
  );
}

function inspectPng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 57 || !buffer.subarray(0, 8).equals(signature)) return null;

  let offset = 8;
  let dimensions = null;
  let sawImageData = false;
  let sawEnd = false;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > buffer.length) return null;
    const type = buffer.toString("ascii", offset + 4, offset + 8);

    if (!dimensions) {
      if (type !== "IHDR" || length !== 13 || offset !== 8) return null;
      const width = buffer.readUInt32BE(offset + 8);
      const height = buffer.readUInt32BE(offset + 12);
      const bitDepth = buffer[offset + 16];
      const colorType = buffer[offset + 17];
      const allowedBitDepths = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !validDimensions(width, height) ||
        !allowedBitDepths[colorType]?.includes(bitDepth) ||
        buffer[offset + 18] !== 0 ||
        buffer[offset + 19] !== 0 ||
        ![0, 1].includes(buffer[offset + 20])
      ) {
        return null;
      }
      dimensions = { width, height };
    } else if (type === "IDAT") {
      sawImageData = true;
    } else if (type === "IEND") {
      if (length !== 0 || chunkEnd !== buffer.length) return null;
      sawEnd = true;
      break;
    }

    offset = chunkEnd;
  }

  if (!dimensions || !sawImageData || !sawEnd) return null;
  return { format: "png", extension: "png", ...dimensions };
}

function inspectJpeg(buffer) {
  if (
    buffer.length < 16 ||
    buffer[0] !== 0xff ||
    buffer[1] !== 0xd8 ||
    buffer[buffer.length - 2] !== 0xff ||
    buffer[buffer.length - 1] !== 0xd9
  ) {
    return null;
  }

  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  let dimensions = null;

  while (offset + 1 < buffer.length - 2) {
    if (buffer[offset] !== 0xff) return null;
    while (buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length - 2) break;
    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length - 2) return null;

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length - 2) return null;

    if (startOfFrameMarkers.has(marker)) {
      if (segmentLength < 8) return null;
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (!validDimensions(width, height)) return null;
      dimensions = { width, height };
    }

    if (marker === 0xda) break;
    offset += segmentLength;
  }

  return dimensions ? { format: "jpeg", extension: "jpg", ...dimensions } : null;
}

function inspectWebp(buffer) {
  if (
    buffer.length < 26 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP" ||
    buffer.readUInt32LE(4) + 8 !== buffer.length
  ) {
    return null;
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.toString("ascii", offset, offset + 4);
    const chunkLength = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const chunkEnd = dataOffset + chunkLength;
    if (chunkEnd > buffer.length) return null;

    let width;
    let height;
    if (chunkType === "VP8X" && chunkLength >= 10) {
      width = 1 + buffer.readUIntLE(dataOffset + 4, 3);
      height = 1 + buffer.readUIntLE(dataOffset + 7, 3);
    } else if (
      chunkType === "VP8 " &&
      chunkLength >= 10 &&
      buffer[dataOffset + 3] === 0x9d &&
      buffer[dataOffset + 4] === 0x01 &&
      buffer[dataOffset + 5] === 0x2a
    ) {
      width = buffer.readUInt16LE(dataOffset + 6) & 0x3fff;
      height = buffer.readUInt16LE(dataOffset + 8) & 0x3fff;
    } else if (chunkType === "VP8L" && chunkLength >= 5 && buffer[dataOffset] === 0x2f) {
      const bits = buffer.readUInt32LE(dataOffset + 1);
      width = 1 + (bits & 0x3fff);
      height = 1 + ((bits >>> 14) & 0x3fff);
    }

    if (width !== undefined) {
      return validDimensions(width, height)
        ? { format: "webp", extension: "webp", width, height }
        : null;
    }

    offset = chunkEnd + (chunkLength % 2);
  }

  return null;
}

function inspectImage(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  return inspectPng(buffer) || inspectJpeg(buffer) || inspectWebp(buffer);
}

function imageDimensions(buffer) {
  const image = inspectImage(buffer);
  return image ? { width: image.width, height: image.height } : null;
}

function ipv4Parts(address) {
  const parts = String(address).split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const values = parts.map(Number);
  return values.every((part) => part >= 0 && part <= 255) ? values : null;
}

function isPublicIpv4(address) {
  const parts = ipv4Parts(address);
  if (!parts) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && [0, 2].includes(parts[2])) return false;
  if (a === 192 && b === 88 && parts[2] === 99) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && parts[2] === 100))) return false;
  if (a === 203 && b === 0 && parts[2] === 113) return false;
  return true;
}

function parseIpv6(address) {
  let value = String(address).toLowerCase();
  if (value.includes("%")) return null;

  const dotted = value.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  let mappedIpv4 = null;
  if (dotted) {
    const parts = ipv4Parts(dotted[1]);
    if (!parts) return null;
    mappedIpv4 = dotted[1];
    const high = ((parts[0] << 8) | parts[1]).toString(16);
    const low = ((parts[2] << 8) | parts[3]).toString(16);
    value = `${value.slice(0, dotted.index + (value[dotted.index] === ":" ? 1 : 0))}${high}:${low}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const parts = [...left, ...Array(missing).fill("0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return { parts: parts.map((part) => Number.parseInt(part, 16)), mappedIpv4 };
}

function isPublicIpv6(address) {
  const parsed = parseIpv6(address);
  if (!parsed) return false;
  const parts = parsed.parts;
  if (parts.every((part) => part === 0) || parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1) {
    return false;
  }
  if ((parts[0] & 0xfe00) === 0xfc00) return false;
  if ((parts[0] & 0xffc0) === 0xfe80 || (parts[0] & 0xffc0) === 0xfec0) return false;
  if ((parts[0] & 0xff00) === 0xff00) return false;
  if (parts[0] === 0x2001 && [0x0000, 0x0002, 0x0db8].includes(parts[1])) return false;

  const isIpv4Mapped = parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff;
  if (isIpv4Mapped) {
    const ipv4 = `${parts[6] >> 8}.${parts[6] & 0xff}.${parts[7] >> 8}.${parts[7] & 0xff}`;
    return isPublicIpv4(parsed.mappedIpv4 || ipv4);
  }
  if (parts.slice(0, 6).every((part) => part === 0)) return false;
  return true;
}

function isPublicAddress(address, family) {
  const detectedFamily = Number(family) || net.isIP(address);
  if (detectedFamily === 4) return isPublicIpv4(address);
  if (detectedFamily === 6) return isPublicIpv6(address);
  return false;
}

function normalizedHostname(hostname) {
  return String(hostname || "")
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function parseRemoteUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw storageError("上游返回了无效的图片下载地址", "unsafe_image_url");
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw storageError("图片下载地址仅允许无凭据的HTTP(S)协议", "unsafe_image_url");
  }
  const hostname = normalizedHostname(url.hostname);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw storageError("已拒绝指向本机或局域网的图片下载地址", "unsafe_image_url");
  }
  return { url, hostname };
}

async function resolveSafeAddresses(hostname, lookupImpl) {
  const literalFamily = net.isIP(hostname);
  let records;
  if (literalFamily) {
    records = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      const result = await lookupImpl(hostname, { all: true, verbatim: true });
      records = Array.isArray(result) ? result : [result];
    } catch (error) {
      throw storageError(`无法解析图片下载地址：${error.message}`, "image_download_dns");
    }
  }

  const normalized = records
    .filter(Boolean)
    .map((record) => ({ address: record.address, family: Number(record.family) || net.isIP(record.address) }));
  if (!normalized.length) {
    throw storageError("图片下载地址没有可用的DNS解析结果", "image_download_dns");
  }
  if (normalized.some((record) => !isPublicAddress(record.address, record.family))) {
    throw storageError("已拒绝指向本机、私网或链路本地地址的图片下载请求", "unsafe_image_url");
  }
  return normalized;
}

function responseHeader(response, name) {
  if (typeof response.headers?.get === "function") return response.headers.get(name);
  const value = response.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function responseStatus(response) {
  return Number(response.status ?? response.statusCode ?? 0);
}

function disposeResponse(response) {
  if (typeof response.destroy === "function") {
    response.destroy();
  } else if (typeof response.body?.cancel === "function") {
    Promise.resolve(response.body.cancel()).catch(() => undefined);
  }
}

function nativeRequest(url, resolvedAddress, signal) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: normalizedHostname(url.hostname),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        agent: false,
        family: resolvedAddress.family,
        lookup(_hostname, _options, callback) {
          callback(null, resolvedAddress.address, resolvedAddress.family);
        },
        headers: {
          Accept: "image/png,image/jpeg,image/webp,*/*;q=0.1",
          "User-Agent": "Wawapi-Image-Console/1.0",
        },
      },
      resolve,
    );
    const abort = () => request.destroy(Object.assign(new Error("Download aborted"), { name: "AbortError" }));
    signal.addEventListener("abort", abort, { once: true });
    request.once("error", reject);
    request.once("close", () => signal.removeEventListener("abort", abort));
    request.end();
  });
}

async function readResponseBytes(response, maxBytes, signal) {
  const declaredLength = Number(responseHeader(response, "content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    disposeResponse(response);
    throw storageError(`图片文件超过${maxBytes}字节限制`, "image_download_too_large");
  }

  const chunks = [];
  let total = 0;
  const body = response.body || response;
  try {
    for await (const chunk of body) {
      if (signal.aborted) throw Object.assign(new Error("Download aborted"), { name: "AbortError" });
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        disposeResponse(response);
        throw storageError(`图片文件超过${maxBytes}字节限制`, "image_download_too_large");
      }
      chunks.push(buffer);
    }
  } catch (error) {
    disposeResponse(response);
    throw error;
  }
  return Buffer.concat(chunks, total);
}

function normalizeStorageOptions(value) {
  if (typeof value === "function") return { fetchImpl: value };
  return value && typeof value === "object" ? value : {};
}

async function downloadRemoteImage(value, options) {
  const timeoutMs = Math.max(1, Number(options.downloadTimeoutMs) || DEFAULT_DOWNLOAD_TIMEOUT_MS);
  const maxBytes = Math.max(1, Number(options.maxDownloadBytes) || DEFAULT_MAX_DOWNLOAD_BYTES);
  const maxRedirects = Math.max(0, Number.isInteger(options.maxRedirects) ? options.maxRedirects : DEFAULT_MAX_REDIRECTS);
  const lookupImpl = options.lookup || dns.lookup;
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(storageError(`图片下载超过${timeoutMs}毫秒`, "image_download_timeout"));
    }, timeoutMs);
  });

  try {
    const download = async () => {
      let current = value;
      for (let redirectCount = 0; ; redirectCount += 1) {
        const { url, hostname } = parseRemoteUrl(current);
        const addresses = await resolveSafeAddresses(hostname, lookupImpl);
        if (controller.signal.aborted) {
          throw storageError(`图片下载超过${timeoutMs}毫秒`, "image_download_timeout");
        }

        let response;
        try {
          response = options.fetchImpl
            ? await options.fetchImpl(url.href, { redirect: "manual", signal: controller.signal })
            : await nativeRequest(url, addresses[0], controller.signal);
        } catch (error) {
          if (controller.signal.aborted || error.name === "AbortError") {
            throw storageError(`图片下载超过${timeoutMs}毫秒`, "image_download_timeout");
          }
          throw storageError(`无法下载上游图片：${error.message}`, "image_download_failed");
        }

        const status = responseStatus(response);
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = responseHeader(response, "location");
          disposeResponse(response);
          if (!location || redirectCount >= maxRedirects) {
            throw storageError("图片下载重定向次数过多或缺少目标地址", "image_download_redirect");
          }
          try {
            current = new URL(location, url).href;
          } catch {
            throw storageError("图片下载重定向地址无效", "image_download_redirect");
          }
          continue;
        }

        if (status < 200 || status >= 300) {
          disposeResponse(response);
          throw storageError(`无法下载生成图片：HTTP ${status || "unknown"}`, "image_download_http");
        }
        return readResponseBytes(response, maxBytes, controller.signal);
      }
    };

    return await Promise.race([download(), timeout]);
  } catch (error) {
    if (controller.signal.aborted && error.code !== "image_download_timeout") {
      throw storageError(`图片下载超过${timeoutMs}毫秒`, "image_download_timeout");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function materializeImage(image, options) {
  if (image.type === "base64") {
    const buffer = decodeBase64(image.value);
    if (!buffer) throw storageError("上游返回了无效的图片base64数据", "invalid_image_output");
    return buffer;
  }

  const embedded = decodeDataUrl(image.value);
  if (embedded) return embedded.buffer;
  if (String(image.value || "").startsWith("data:")) {
    throw storageError("上游返回了无效的图片data URL", "invalid_image_output");
  }
  return downloadRemoteImage(image.value, options);
}

async function writeHistoryFile(historyFile, entries) {
  const tempFile = `${historyFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempFile, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    await fs.rename(tempFile, historyFile);
  } finally {
    await fs.rm(tempFile, { force: true }).catch(() => undefined);
  }
}

async function readHistoryFile(historyFile) {
  const data = JSON.parse(await fs.readFile(historyFile, "utf8"));
  if (!Array.isArray(data)) {
    const error = new Error("History data must be an array");
    error.code = "INVALID_HISTORY_SHAPE";
    throw error;
  }
  return data;
}

function createStorage(rootDir, rawOptions = {}) {
  const options = normalizeStorageOptions(rawOptions);
  const outputDir = path.join(rootDir, "output");
  const dataDir = path.join(rootDir, "data");
  const historyFile = path.join(dataDir, "history.json");
  const historyBackupFile = path.join(dataDir, "history.backup.json");
  let historyQueue = Promise.resolve();
  let historyNotice = null;
  let historyBackupChecked = false;

  async function ensureDirectories() {
    await Promise.all([
      fs.mkdir(outputDir, { recursive: true }),
      fs.mkdir(dataDir, { recursive: true }),
    ]);
  }

  async function readHistory() {
    await ensureDirectories();
    let data;
    try {
      data = await readHistoryFile(historyFile);
    } catch (error) {
      const recoverable = error.code === "ENOENT" || error.code === "INVALID_HISTORY_SHAPE" || error instanceof SyntaxError;
      if (!recoverable) throw error;

      let backupData;
      try {
        backupData = await readHistoryFile(historyBackupFile);
      } catch (backupError) {
        if (error.code === "ENOENT" && backupError.code === "ENOENT") return [];
        let preservedFilename = null;
        if (error.code !== "ENOENT") {
          preservedFilename = `history.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
          try {
            await fs.rename(historyFile, path.join(dataDir, preservedFilename));
          } catch (preserveError) {
            if (preserveError.code !== "ENOENT") throw preserveError;
          }
        }
        historyNotice = {
          id: `corrupt-preserved-${Date.now()}`,
          kind: "corrupt_preserved",
          message: "历史索引无法读取，损坏文件已保留；现有图片仍在output目录",
          preservedFilename,
        };
        return [];
      }

      data = backupData;
      let preservedFilename = null;
      let canRestorePrimary = true;
      if (error.code !== "ENOENT") {
        preservedFilename = `history.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
        try {
          await fs.rename(historyFile, path.join(dataDir, preservedFilename));
        } catch (preserveError) {
          if (preserveError.code !== "ENOENT") canRestorePrimary = false;
        }
      }
      let restoredPrimary = false;
      if (canRestorePrimary) {
        try {
          await writeHistoryFile(historyFile, data);
          restoredPrimary = true;
        } catch {
          restoredPrimary = false;
        }
      }
      historyBackupChecked = true;
      historyNotice = {
        id: `${restoredPrimary ? "backup-restored" : "backup-read-only"}-${Date.now()}`,
        kind: restoredPrimary ? "backup_restored" : "backup_read_only",
        message: restoredPrimary
          ? "历史索引异常，已从备份恢复；生成图片文件未受影响"
          : "主历史索引暂时无法恢复，当前已从备份读取；生成图片文件未受影响",
        preservedFilename,
      };
    }

    if (!historyBackupChecked) {
      historyBackupChecked = true;
      try {
        const backupData = await readHistoryFile(historyBackupFile);
        if (JSON.stringify(backupData) !== JSON.stringify(data)) {
          await writeHistoryFile(historyBackupFile, data);
        }
      } catch (backupError) {
        const repairable = backupError.code === "ENOENT" || backupError.code === "INVALID_HISTORY_SHAPE" || backupError instanceof SyntaxError;
        if (!repairable) throw backupError;
        try {
          await writeHistoryFile(historyBackupFile, data);
        } catch {
          historyNotice = {
            id: `backup-write-failed-${Date.now()}`,
            kind: "backup_write_failed",
            message: "历史记录可用，但备份索引写入失败",
            preservedFilename: null,
          };
        }
      }
    }

    try {
      await Promise.all(
        data.flatMap((entry) => {
          entry.transport ||= "sync";
          entry.attempts ||= 1;
          entry.pollCount ||= 0;
          entry.requestedCount ||= Array.isArray(entry.images) ? entry.images.length : 1;
          return (entry.images || []).map(async (image) => {
            image.downloadUrl ||= `/api/download/${encodeURIComponent(image.filename)}`;
            if (image.width && image.height && image.format) return;
            try {
              const inspected = inspectImage(
                await fs.readFile(path.join(outputDir, path.basename(image.filename))),
              );
              image.width = inspected?.width || null;
              image.height = inspected?.height || null;
              image.format = inspected?.format || null;
            } catch {
              image.width = null;
              image.height = null;
              image.format = null;
            }
          });
        }),
      );
      return data;
    } catch (error) {
      throw error;
    }
  }

  function getHistoryNotice() {
    return historyNotice;
  }

  async function writeHistory(entries) {
    await writeHistoryFile(historyFile, entries);
    try {
      await writeHistoryFile(historyBackupFile, entries);
      historyBackupChecked = true;
    } catch {
      historyNotice = {
        id: `backup-write-failed-${Date.now()}`,
        kind: "backup_write_failed",
        message: "历史记录已保存，但备份索引写入失败",
        preservedFilename: null,
      };
    }
  }

  async function updateHistory(mutator) {
    historyQueue = historyQueue.catch(() => undefined).then(async () => {
      const current = await readHistory();
      const next = await mutator(current);
      await writeHistory(next.slice(0, 100));
      return next;
    });
    return historyQueue;
  }

  async function saveGeneration(apiResult, meta) {
    await ensureDirectories();
    const id = randomUUID();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const preparedImages = [];

    for (const image of apiResult.images) {
      const buffer = await materializeImage(image, options);
      if (buffer.length > (Number(options.maxDownloadBytes) || DEFAULT_MAX_DOWNLOAD_BYTES)) {
        throw storageError("上游返回的图片文件过大", "invalid_image_output");
      }
      const inspected = inspectImage(buffer);
      if (!inspected) {
        throw storageError("上游返回的内容不是有效的PNG、JPEG或WebP图片", "invalid_image_output");
      }
      preparedImages.push({ image, buffer, inspected });
    }

    const savedImages = [];
    const writtenFiles = [];
    try {
      for (const { image, buffer, inspected } of preparedImages) {
        const imageIndex = Number.isInteger(image.index) ? image.index : savedImages.length;
        const filename = `${stamp}-${id.slice(0, 8)}-${imageIndex + 1}.${inspected.extension}`;
        const outputPath = path.join(outputDir, filename);
        await fs.writeFile(outputPath, buffer);
        writtenFiles.push(outputPath);
        savedImages.push({
          id: `${id}-${imageIndex}`,
          filename,
          url: `/output/${encodeURIComponent(filename)}`,
          downloadUrl: `/api/download/${encodeURIComponent(filename)}`,
          width: inspected.width,
          height: inspected.height,
          format: inspected.format,
        });
      }

      const entry = {
        id,
        createdAt: new Date().toISOString(),
        prompt: meta.prompt,
        model: meta.model,
        size: meta.size,
        quality: meta.quality,
        outputFormat: meta.outputFormat,
        requestedCount: Number.parseInt(meta.n, 10) || 1,
        elapsedMs: meta.elapsedMs || null,
        hasReferenceImage: Boolean(meta.hasReferenceImage),
        attempts: apiResult.attempts || 1,
        transport: apiResult.transport || "sync",
        taskId: apiResult.taskId || null,
        pollCount: apiResult.pollCount || 0,
        images: savedImages,
        revisedPrompt: apiResult.revisedPrompt,
        usage: apiResult.usage,
      };

      await updateHistory((history) => [entry, ...history]);
      return entry;
    } catch (error) {
      await Promise.all(writtenFiles.map((filename) => fs.rm(filename, { force: true })));
      throw error;
    }
  }

  async function deleteEntry(id) {
    let deleted = null;
    await updateHistory(async (history) => {
      deleted = history.find((entry) => entry.id === id) || null;
      if (deleted) {
        await Promise.all(
          deleted.images.map((image) =>
            fs.rm(path.join(outputDir, path.basename(image.filename)), { force: true }),
          ),
        );
      }
      return history.filter((entry) => entry.id !== id);
    });
    return deleted;
  }

  return { deleteEntry, getHistoryNotice, outputDir, readHistory, saveGeneration };
}

module.exports = {
  createStorage,
  decodeDataUrl,
  extensionFor,
  formatFromContentType,
  imageDimensions,
  inspectImage,
  isPublicAddress,
};
