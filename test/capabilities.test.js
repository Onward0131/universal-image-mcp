const test = require("node:test");
const assert = require("node:assert/strict");

const {
  aspectStatus,
  explainCapability,
  ratioErrorPercent,
  selectModel,
} = require("../lib/capabilities");

const models = ["gpt-image-2", "gpt-image-2-high", "gpt-image-2-low", "gpt-image-2-medium"];

test("auto selection uses an exact variant for high resolution", () => {
  const selected = selectModel({ models, size: "3840x2160" });
  assert.equal(selected.model, "gpt-image-2-high");
  assert.equal(selected.reason, "high_resolution_prefers_exact_variant");

  const explanation = explainCapability({ models, size: "3840x2160" });
  assert.equal(explanation.selectedModel, "gpt-image-2-high");
  assert.equal(explanation.expectedStatus, "exact");
});

test("auto text generation uses the reliable exact variant before the base model", () => {
  const selected = selectModel({ models, size: "1024x1024" });
  assert.equal(selected.model, "gpt-image-2-high");
  assert.equal(selected.reason, "text_generation_prefers_reliable_variant");
});

test("format evidence does not borrow a PNG result for a WebP request", () => {
  const baseline = {
    generatedAt: "2026-08-02T00:00:00Z",
    events: [
      {
        outcome: "success",
        model: "gpt-image-2-high",
        requestedSize: "1024x1024",
        requestedFormat: "png",
        hasReferenceImage: false,
        actual: [{ width: 1024, height: 1024, format: "png" }],
        httpStatus: 200,
      },
      {
        outcome: "success",
        model: "gpt-image-2-high",
        requestedSize: "1024x1024",
        requestedFormat: "webp",
        hasReferenceImage: false,
        actual: [{ width: 1024, height: 1024, format: "webp" }],
        httpStatus: 200,
      },
    ],
  };
  const webp = explainCapability({
    models,
    model: "gpt-image-2-high",
    size: "1024x1024",
    format: "webp",
    baseline,
  });
  assert.equal(webp.expectedStatus, "exact");
  assert.equal(webp.evidence[0].requestedFormat, "webp");

  const jpeg = explainCapability({
    models,
    model: "gpt-image-2-high",
    size: "1024x1024",
    format: "jpeg",
    baseline,
  });
  assert.equal(jpeg.expectedStatus, "unknown");
  assert.equal(jpeg.evidence.length, 0);
});

test("count-aware evidence distinguishes one image from two independent images", () => {
  const multi = explainCapability({
    models,
    model: "gpt-image-2-high",
    size: "1024x1024",
    format: "jpeg",
    count: 2,
  });
  assert.equal(multi.requestedCount, 2);
  assert.equal(multi.expectedStatus, "exact");
  assert.equal(multi.expectedCountStatus, "exact");
  assert.equal(multi.evidence[0].requestedCount, 2);
  assert.equal(multi.evidence[0].actualCount, 2);
  assert.ok(multi.cautions.includes("multiple_images_are_time_point_evidence_not_a_guarantee"));

  const single = explainCapability({
    models,
    model: "gpt-image-2-high",
    size: "1024x1024",
    format: "jpeg",
    count: 1,
  });
  assert.equal(single.expectedStatus, "unknown");
  assert.equal(single.expectedCountStatus, "unknown");
  assert.equal(single.evidence.length, 0);
});

test("latest base-model standard generation supersedes earlier transient failures", () => {
  const explanation = explainCapability({
    models: ["gpt-image-2"],
    model: "gpt-image-2",
    size: "1024x1024",
    format: "png",
    count: 1,
  });
  assert.equal(explanation.expectedStatus, "exact");
  assert.equal(explanation.expectedSizeStatus, "exact");
  assert.equal(explanation.expectedFormatStatus, "exact");
  assert.equal(explanation.expectedCountStatus, "exact");
  assert.equal(explanation.evidence[0].observedAt, "2026-08-04T17:43:30+08:00");
  assert.equal(explanation.evidence[0].status, "exact");
  assert.ok(explanation.evidence.slice(1).some((item) => item.status === "transient_failure"));
});

test("latest base-model multi-image evidence keeps count and size exact while format falls back", () => {
  const explanation = explainCapability({
    models: ["gpt-image-2"],
    model: "gpt-image-2",
    size: "1024x1024",
    format: "jpeg",
    count: 2,
  });
  assert.equal(explanation.expectedStatus, "degraded");
  assert.equal(explanation.expectedSizeStatus, "exact");
  assert.equal(explanation.expectedFormatStatus, "degraded");
  assert.equal(explanation.expectedCountStatus, "exact");
  assert.equal(explanation.evidence[0].observedAt, "2026-08-04T17:46:56+08:00");
  assert.equal(explanation.evidence[0].actualCount, 2);
  assert.equal(explanation.evidence[0].actual.length, 2);
  assert.equal(explanation.evidence[1].actualCount, 1);
  assert.ok(explanation.cautions.includes("multiple_images_are_time_point_evidence_not_a_guarantee"));
});

test("latest HTTP 524 remains transient while older exact evidence stays visible", () => {
  const explanation = explainCapability({
    models,
    model: "gpt-image-2-high",
    size: "1024x1024",
    format: "png",
    count: 1,
  });
  assert.equal(explanation.expectedStatus, "transient_failure");
  assert.equal(explanation.evidence[0].httpStatus, 524);
  assert.equal(explanation.evidence[0].status, "transient_failure");
  assert.ok(explanation.evidence.slice(1).some((item) => item.status === "exact"));
  assert.ok(explanation.cautions.includes("transient_http_failure_is_not_unsupported"));
});

test("capability status degrades when returned file count differs", () => {
  const baseline = {
    generatedAt: "2026-08-04T00:00:00Z",
    events: [{
      outcome: "success",
      model: "gpt-image-2",
      requestedSize: "1024x1024",
      requestedFormat: "png",
      requestedCount: 2,
      hasReferenceImage: false,
      actual: [{ width: 1024, height: 1024, format: "png" }],
      httpStatus: 200,
    }],
  };
  const explanation = explainCapability({
    models,
    model: "gpt-image-2",
    size: "1024x1024",
    format: "png",
    count: 2,
    baseline,
  });
  assert.equal(explanation.expectedStatus, "degraded");
  assert.equal(explanation.expectedSizeStatus, "exact");
  assert.equal(explanation.expectedFormatStatus, "exact");
  assert.equal(explanation.expectedCountStatus, "degraded");
  assert.equal(explanation.evidence[0].actualCount, 1);
});

test("auto selection prefers the base model for reference images", () => {
  const baseline = {
    generatedAt: "2026-08-02T00:00:00Z",
    events: [
      {
        outcome: "failure",
        model: "gpt-image-2",
        requestedSize: "1024x1024",
        requestedFormat: "png",
        requestedCount: 1,
        hasReferenceImage: true,
        httpStatus: 502,
      },
      {
        outcome: "success",
        model: "gpt-image-2",
        requestedSize: "1024x1024",
        requestedFormat: "png",
        requestedCount: 1,
        hasReferenceImage: true,
        actual: [{ width: 1254, height: 1254, format: "png" }],
        httpStatus: 200,
      },
    ],
  };
  const explanation = explainCapability({
    models,
    size: "1024x1024",
    hasReferenceImage: true,
    baseline,
  });
  assert.equal(explanation.selectedModel, "gpt-image-2");
  assert.equal(explanation.expectedStatus, "transient_failure");
  assert.equal(explanation.evidence[1].status, "degraded");
});

test("base-model degradation remains visible even when older exact evidence exists", () => {
  const baseline = {
    generatedAt: "2026-08-02T00:00:00Z",
    events: [
      {
        outcome: "success",
        model: "gpt-image-2",
        requestedSize: "3840x2160",
        requestedFormat: "png",
        requestedCount: 1,
        hasReferenceImage: false,
        actual: [{ width: 1672, height: 941, format: "png" }],
        httpStatus: 200,
      },
      {
        outcome: "success",
        model: "gpt-image-2",
        requestedSize: "3840x2160",
        requestedFormat: "png",
        requestedCount: 1,
        hasReferenceImage: false,
        actual: [{ width: 3840, height: 2160, format: "png" }],
        httpStatus: 200,
      },
    ],
  };
  const explanation = explainCapability({
    models,
    model: "gpt-image-2",
    size: "3840x2160",
    baseline,
  });
  assert.equal(explanation.evidence.length, 2);
  assert.equal(explanation.evidence[0].status, "degraded");
  assert.equal(explanation.evidence[1].status, "exact");
  assert.equal(explanation.expectedStatus, "degraded");
});

test("aspect classification distinguishes exact, rounding, and changed ratios", () => {
  assert.equal(aspectStatus("2048x2048", "1254x1254"), "exact");
  assert.equal(aspectStatus("4096x2160", "3840x2016"), "preserved_with_rounding");
  assert.equal(aspectStatus("1024x1024", "1536x1024"), "changed");
  assert.ok(ratioErrorPercent("4096x2160", "3840x2016") < 1);
});

test("variant reference-image 502 stays transient rather than unsupported", () => {
  const explanation = explainCapability({
    models,
    model: "gpt-image-2-low",
    size: "1024x1024",
    hasReferenceImage: true,
  });
  assert.equal(explanation.expectedStatus, "transient_failure");
  assert.ok(explanation.cautions.includes("transient_http_failure_is_not_unsupported"));
});
