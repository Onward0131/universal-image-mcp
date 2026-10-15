function createModelCatalog(models, defaultModel = "") {
  const normalized = [...new Set((Array.isArray(models) ? models : []).map((model) => String(model || "").trim()).filter(Boolean))];
  const candidates = normalized.filter((id) => /image|dall-e|flux|imagen|stable-diffusion|ideogram/i.test(id));
  return {
    models: normalized,
    defaultModel: defaultModel || null,
    activeModel: defaultModel || (candidates.length === 1 ? candidates[0] : null),
    mode: normalized.length === 1 ? "single" : normalized.length > 1 ? "multi" : "unknown",
    modelCount: normalized.length,
    catalogSource: normalized.length ? "upstream" : "empty",
  };
}

module.exports = { createModelCatalog };
