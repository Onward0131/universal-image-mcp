const test = require("node:test");
const assert = require("node:assert/strict");
const { createModelCatalog } = require("../lib/model-catalog");

test("createModelCatalog exposes four image models as a multi-model channel", () => {
  const catalog = createModelCatalog([
    "gpt-image-2",
    "gpt-image-2-high",
    "gpt-image-2-low",
    "gpt-image-2-medium",
    "gpt-5.1",
  ]);

  assert.deepEqual(catalog.models, [
    "gpt-image-2",
    "gpt-image-2-high",
    "gpt-image-2-low",
    "gpt-image-2-medium",
  ]);
  assert.equal(catalog.mode, "multi");
  assert.equal(catalog.modelCount, 4);
  assert.equal(catalog.activeModel, "gpt-image-2");
  assert.equal(catalog.catalogSource, "upstream");
});

test("createModelCatalog selects the only upstream model when the configured default is absent", () => {
  const catalog = createModelCatalog(["gpt-image-2-low"], "gpt-image-2");

  assert.deepEqual(catalog.models, ["gpt-image-2-low"]);
  assert.equal(catalog.mode, "single");
  assert.equal(catalog.modelCount, 1);
  assert.equal(catalog.defaultModel, "gpt-image-2");
  assert.equal(catalog.activeModel, "gpt-image-2-low");
});

test("createModelCatalog falls back to the configured model when discovery is empty", () => {
  const catalog = createModelCatalog([], "gpt-image-custom");

  assert.deepEqual(catalog.models, ["gpt-image-custom"]);
  assert.equal(catalog.mode, "single");
  assert.equal(catalog.activeModel, "gpt-image-custom");
  assert.equal(catalog.catalogSource, "fallback");
});

test("createModelCatalog removes empty and duplicate model identifiers", () => {
  const catalog = createModelCatalog([
    "gpt-image-2",
    "",
    " gpt-image-2 ",
    null,
    "dall-e-3",
  ]);

  assert.deepEqual(catalog.models, ["gpt-image-2", "dall-e-3"]);
  assert.equal(catalog.modelCount, 2);
});
