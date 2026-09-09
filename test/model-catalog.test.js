const test = require("node:test");
const assert = require("node:assert/strict");
const { createModelCatalog } = require("../lib/model-catalog");
test("catalog preserves all IDs without inventing an active model", () => {
  const c = createModelCatalog(["image-a", "image-b", "text-only"]);
  assert.equal(c.modelCount, 3);
  assert.equal(c.activeModel, null);
});
test("configured deployment stays active even when absent from directory", () => {
  const c = createModelCatalog(["image-a"], "deployment-b");
  assert.equal(c.activeModel, "deployment-b");
  assert.deepEqual(c.models, ["image-a"]);
});
test("empty discovery does not pretend the configured model was returned", () => {
  const c = createModelCatalog([], "deployment-b");
  assert.deepEqual(c.models, []);
  assert.equal(c.activeModel, "deployment-b");
  assert.equal(c.catalogSource, "empty");
});
test("normalizes duplicates and selects only an unambiguous image candidate", () => {
  const c = createModelCatalog(["image-a", " image-a ", null, "text-only"]);
  assert.equal(c.modelCount, 2);
  assert.equal(c.activeModel, "image-a");
});
