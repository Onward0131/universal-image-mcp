const DEFAULT_IMAGE_MODEL = "gpt-image-2";

function createModelCatalog(models, defaultModel = DEFAULT_IMAGE_MODEL) {
  const configuredDefault = String(defaultModel || DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL;
  const normalized = [...new Set(
    (Array.isArray(models) ? models : [])
      .map((model) => String(model || "").trim())
      .filter(Boolean),
  )];
  const imageModels = normalized.filter((model) => /(?:image|dall-e)/i.test(model));
  const available = imageModels.length > 0 ? imageModels : normalized;
  const catalogSource = available.length > 0 ? "upstream" : "fallback";
  const catalogModels = available.length > 0 ? available : [configuredDefault];
  const activeModel = catalogModels.includes(configuredDefault)
    ? configuredDefault
    : catalogModels[0];

  return {
    models: catalogModels,
    defaultModel: configuredDefault,
    activeModel,
    mode: catalogModels.length === 1 ? "single" : "multi",
    modelCount: catalogModels.length,
    catalogSource,
  };
}

module.exports = {
  createModelCatalog,
  DEFAULT_IMAGE_MODEL,
};
