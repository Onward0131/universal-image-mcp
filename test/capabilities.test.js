const test = require("node:test");
const assert = require("node:assert/strict");

const {
  aspectStatus,
  explainCapability,
  ratioErrorPercent,
  selectModel,
} = require("../lib/capabilities");

const models = ["gpt-image-2", "gpt-image-2-high", "gpt-image-2-low", "gpt-image-2-medium"];



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

test("reference observations remain scoped to an explicitly selected model", () => {
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
    model: "gpt-image-2",
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


test("ambiguous catalogs never choose a preferred vendor model", () => {
  assert.equal(selectModel({ models, size: "3840x2160" }).model, null);
  assert.equal(selectModel({ models, hasReferenceImage: true }).model, null);
  assert.equal(selectModel({ models: ["flux-art", "text-only"] }).model, "flux-art");
  assert.equal(selectModel({ models, configuredModel: "my-deployment" }).model, "my-deployment");
});

test("no capability observations are bundled for unrelated connections", () => {
  const result = explainCapability({ model: "gpt-image-2", size: "1024x1024", count: 2 });
  assert.equal(result.expectedStatus, "unknown");
  assert.equal(result.expectedCountStatus, "unknown");
  assert.deepEqual(result.evidence, []);
});
