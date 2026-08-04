const fs = require("node:fs");
const path = require("node:path");

const BASELINE_PATH = path.resolve(__dirname, "..", "resources", "capabilities.json");
const HIGH_RESOLUTION_MODELS = [
  "gpt-image-2-high",
  "gpt-image-2-medium",
  "gpt-image-2-low",
  "gpt-image-2",
];
const TEXT_MODELS = [
  "gpt-image-2-high",
  "gpt-image-2-medium",
  "gpt-image-2-low",
  "gpt-image-2",
];
const REFERENCE_MODELS = [
  "gpt-image-2",
  "gpt-image-2-high",
  "gpt-image-2-medium",
  "gpt-image-2-low",
];

function parseSize(size) {
  const match = /^(\d+)x(\d+)$/i.exec(String(size || "").trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return null;
  return { width, height, longestEdge: Math.max(width, height), ratio: width / height };
}

function ratioErrorPercent(requested, actual) {
  const expected = parseSize(requested);
  const observed = parseSize(actual);
  if (!expected || !observed) return null;
  return Math.abs((observed.ratio / expected.ratio) - 1) * 100;
}

function aspectStatus(requested, actual) {
  const errorPercent = ratioErrorPercent(requested, actual);
  if (errorPercent === null) return "unknown";
  if (errorPercent < 0.01) return "exact";
  if (errorPercent <= 1) return "preserved_with_rounding";
  return "changed";
}

function isHighResolution(size) {
  const parsed = parseSize(size);
  return Boolean(parsed && parsed.longestEdge >= 2048);
}

function loadCapabilityBaseline(filePath = BASELINE_PATH) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return {
    version: parsed.version || 1,
    generatedAt: parsed.generatedAt || null,
    description: parsed.description || null,
    events: Array.isArray(parsed.events) ? parsed.events : [],
  };
}

function selectModel({ models = [], requestedModel = "auto", size = "1024x1024", hasReferenceImage = false }) {
  const available = [...new Set(models.map((value) => String(value || "").trim()).filter(Boolean))];
  const explicit = String(requestedModel || "auto").trim();

  if (explicit && explicit !== "auto") {
    return {
      model: explicit,
      reason: "explicit_model",
      available: !available.length || available.includes(explicit),
    };
  }

  const preferences = hasReferenceImage
    ? REFERENCE_MODELS
    : isHighResolution(size)
      ? HIGH_RESOLUTION_MODELS
      : TEXT_MODELS;
  const selected = preferences.find((model) => available.includes(model)) || available[0] || "gpt-image-2";
  return {
    model: selected,
    reason: hasReferenceImage
      ? "reference_image_prefers_base_model"
      : isHighResolution(size)
        ? "high_resolution_prefers_exact_variant"
        : "text_generation_prefers_reliable_variant",
    available: Boolean(available.length ? available.includes(selected) : true),
  };
}

function normalizeFormat(value) {
  const format = String(value || "png").toLowerCase();
  return format === "jpg" ? "jpeg" : format;
}

function normalizeCount(value) {
  const count = Number.parseInt(value, 10);
  return Number.isInteger(count) && count > 0 ? count : 1;
}

function eventOutcome(event) {
  const requestedCount = normalizeCount(event.requestedCount);
  if (event.outcome !== "success") {
    return {
      status: [502, 503, 524].includes(Number(event.httpStatus)) ? "transient_failure" : "failed",
      sizeStatus: "unknown",
      formatStatus: "unknown",
      countStatus: "unknown",
      aspectStatus: "unknown",
      requestedCount,
      actualCount: 0,
      actual: [],
    };
  }

  const actual = (event.actual || []).map((image) => ({
    width: image.width || null,
    height: image.height || null,
    size: image.width && image.height ? `${image.width}x${image.height}` : null,
    format: normalizeFormat(image.format),
  }));
  const sizes = [...new Set(actual.map((image) => image.size).filter(Boolean))];
  const formats = [...new Set(actual.map((image) => image.format).filter(Boolean))];
  const requestedFormat = normalizeFormat(event.requestedFormat);
  const sizeExact = sizes.length === 1 && sizes[0] === event.requestedSize;
  const formatExact = formats.length === 1 && formats[0] === requestedFormat;
  const actualCount = actual.length;
  const countExact = actualCount === requestedCount;
  const ratioStates = sizes.map((size) => aspectStatus(event.requestedSize, size));

  return {
    status: sizeExact && formatExact && countExact ? "exact" : "degraded",
    sizeStatus: sizeExact ? "exact" : "degraded",
    formatStatus: formatExact ? "exact" : "degraded",
    countStatus: countExact ? "exact" : "degraded",
    aspectStatus: ratioStates.includes("changed")
      ? "changed"
      : ratioStates.includes("preserved_with_rounding")
        ? "preserved_with_rounding"
        : ratioStates.length
          ? "exact"
          : "unknown",
    requestedCount,
    actualCount,
    actual,
  };
}

function evidenceForRequest(baseline, options) {
  return baseline.events
    .filter((event) => event.model === options.model)
    .filter((event) => String(event.requestedSize) === String(options.size))
    .filter((event) => normalizeFormat(event.requestedFormat) === normalizeFormat(options.format))
    .filter((event) => normalizeCount(event.requestedCount) === normalizeCount(options.count))
    .filter((event) => Boolean(event.hasReferenceImage) === Boolean(options.hasReferenceImage))
    .sort((left, right) => String(right.observedAt || "").localeCompare(String(left.observedAt || "")))
    .map((event) => ({
      observedAt: event.observedAt || null,
      source: event.source || "baseline",
      httpStatus: event.httpStatus || null,
      note: event.note || null,
      requestedSize: event.requestedSize,
      requestedFormat: normalizeFormat(event.requestedFormat),
      hasReferenceImage: Boolean(event.hasReferenceImage),
      ...eventOutcome(event),
    }));
}

function explainCapability(options = {}) {
  const baseline = options.baseline || loadCapabilityBaseline();
  const size = String(options.size || "1024x1024");
  const count = normalizeCount(options.count);
  const hasReferenceImage = Boolean(options.hasReferenceImage);
  const selection = selectModel({
    models: options.models || [],
    requestedModel: options.model || "auto",
    size,
    hasReferenceImage,
  });
  const evidence = evidenceForRequest(baseline, {
    model: selection.model,
    size,
    format: options.format || "png",
    count,
    hasReferenceImage,
  });
  const latest = evidence[0] || null;

  const cautions = [];
  if (!latest) cautions.push("no_matching_evidence");
  if (latest?.status === "degraded") cautions.push("provider_may_silently_degrade_output");
  if (latest?.status === "transient_failure") cautions.push("transient_http_failure_is_not_unsupported");
  if (hasReferenceImage && selection.model !== "gpt-image-2") {
    cautions.push("variant_reference_support_is_uncertain");
  }
  if (isHighResolution(size)) cautions.push("high_resolution_is_time_point_evidence_not_a_guarantee");
  if (count > 1) cautions.push("multiple_images_are_time_point_evidence_not_a_guarantee");

  return {
    baselineGeneratedAt: baseline.generatedAt,
    selectedModel: selection.model,
    selectionReason: selection.reason,
    selectedModelAvailable: selection.available,
    requestedSize: size,
    requestedFormat: normalizeFormat(options.format || "png"),
    requestedCount: count,
    hasReferenceImage,
    expectedStatus: latest?.status || "unknown",
    expectedSizeStatus: latest?.sizeStatus || "unknown",
    expectedFormatStatus: latest?.formatStatus || "unknown",
    expectedCountStatus: latest?.countStatus || "unknown",
    expectedAspectStatus: latest?.aspectStatus || "unknown",
    cautions,
    evidence,
  };
}

module.exports = {
  BASELINE_PATH,
  aspectStatus,
  eventOutcome,
  explainCapability,
  isHighResolution,
  loadCapabilityBaseline,
  normalizeCount,
  parseSize,
  ratioErrorPercent,
  selectModel,
};
