const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  compareOutput,
  doctor,
  errorEnvelope,
  generateImage,
  inspectImageFile,
} = require("../lib/bridge");

function pngChunk(type, data = Buffer.alloc(0)) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  return chunk;
}

function makePng(width = 1, height = 1) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Buffer.from([0x78, 0x9c])),
    pngChunk("IEND"),
  ]);
}

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "universal-image-mcp-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function config(outputDir, key = "test-secret-123456789") {
  return {
    model: "gpt-image-2",
    apiKey: key,
    apiKeyPresent: Boolean(key),
    authSource: key ? "env" : "missing",
    baseUrl: "https://example.com/v1",
    configFile: path.join(outputDir, "config.json"),
    defaultOutputDir: outputDir,
  };
}

test("doctor remains machine-readable when auth is missing", async (t) => {
  const root = await tempRoot(t);
  const result = await doctor(config(root, ""));
  assert.equal(result.ok, true);
  assert.equal(result.data.ready, false);
  assert.equal(result.data.checks.auth.status, "missing");
  assert.equal(result.data.checks.endpoint.status, "not_checked");
  assert.equal(result.data.generation_channel_status, "not_probed");
  assert.equal(result.data.issues.length, 1);
  assert.equal(result.warnings.length, 0);
});

test("doctor separates catalog verification from generation-channel status", async (t) => {
  const root = await tempRoot(t);
  const result = await doctor(config(root), {
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "gpt-image-2-high" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.equal(result.data.ready, true);
  assert.equal(result.data.catalog_status, "verified");
  assert.equal(result.data.generation_channel_status, "not_probed");
  assert.equal(result.data.checks.endpoint.scope, "model_catalog_only");
  assert.equal(result.data.checks.endpoint.attempts, 1);
  assert.deepEqual(result.data.issues, []);
  assert.deepEqual(result.warnings, []);
});

test("doctor reports DNS diagnostics as a non-blocking catalog warning", async (t) => {
  const root = await tempRoot(t);
  let calls = 0;
  const result = await doctor(config(root), {
    catalogRetryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      const cause = Object.assign(new Error("getaddrinfo ENOTFOUND provider.example"), { code: "ENOTFOUND" });
      const error = new TypeError("fetch failed");
      error.cause = cause;
      throw error;
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.data.ready, true);
  assert.equal(result.data.catalog_status, "unverified");
  assert.equal(result.data.generation_channel_status, "not_probed");
  assert.deepEqual(result.data.issues, []);
  assert.equal(result.warnings[0].code, "model_catalog_unverified");
  assert.equal(result.warnings[0].probe_error.network_category, "dns_resolution");
  assert.equal(result.warnings[0].probe_error.cause_code, "ENOTFOUND");
  assert.match(result.warnings[0].message, /不代表.*生成渠道不可用/);
});

test("doctor does not treat a catalog channel message as generation-channel evidence", async (t) => {
  const root = await tempRoot(t);
  let calls = 0;
  const result = await doctor(config(root), {
    catalogRetryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "暂无可用渠道" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.data.ready, true);
  assert.equal(result.data.catalog_status, "unverified");
  assert.equal(result.data.generation_channel_status, "not_probed");
  assert.equal(result.warnings[0].probe_error.code, "upstream_channel_unavailable");
  assert.match(result.warnings[0].next_actions.join("\n"), /真实生成接口/);
});

test("doctor blocks only a definite authentication failure and always explains ready=false", async (t) => {
  const root = await tempRoot(t);
  const result = await doctor(config(root), {
    catalogRetryDelayMs: 0,
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.equal(result.data.ready, false);
  assert.equal(result.data.catalog_status, "failed");
  assert.equal(result.data.issues[0].code, "invalid_api_key");
  assert.ok(result.data.issues.length > 0);
});

test("offline doctor validates local readiness without claiming remote availability", async (t) => {
  const root = await tempRoot(t);
  const result = await doctor(config(root), { probeCatalog: false });
  assert.equal(result.data.ready, true);
  assert.equal(result.data.catalog_status, "not_probed");
  assert.equal(result.data.generation_channel_status, "not_probed");
  assert.equal(result.data.checks.endpoint.reason, "catalog_probe_disabled");
});

test("generation honors the configured model and saves only text-addressable metadata", async (t) => {
  const root = await tempRoot(t);
  const image = makePng(2048, 2048);
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [
        { id: "gpt-image-2" },
        { id: "gpt-image-2-high" },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: [{ b64_json: image.toString("base64") }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await generateImage(config(root), {
    prompt: "test image",
    size: "2048x2048",
    quality: "low",
    format: "png",
    output: path.join(root, "result.png"),
  }, { fetchImpl: fakeFetch });

  assert.equal(result.ok, true);
  assert.equal(result.data.request.model, "gpt-image-2");
  assert.equal(result.data.capability.selectionReason, "configured_model");
  assert.equal(result.data.result.status, "exact");
  assert.equal(result.data.result.images[0].size, "2048x2048");
  assert.match(result.data.result.images[0].markdown, /^!\[generated image\]\(<.+>\)$/);
  assert.equal("b64_json" in result.data.result.images[0], false);
  assert.equal(calls.filter((call) => call.url.endsWith("/models")).length, 1);
  assert.equal(JSON.parse(calls.at(-1).options.body).model, "gpt-image-2");
});

test("silent provider degradation is classified with proportional evidence", async (t) => {
  const root = await tempRoot(t);
  const image = makePng(1254, 1254);
  const fakeFetch = async (url) => {
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "gpt-image-2" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: [{ b64_json: image.toString("base64") }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await generateImage(config(root), {
    prompt: "degrade",
    model: "gpt-image-2",
    size: "2048x2048",
    output: root,
  }, { fetchImpl: fakeFetch });

  assert.equal(result.data.result.status, "degraded");
  assert.equal(result.data.result.deviations[0].code, "size_mismatch");
  assert.equal(result.data.result.deviations[0].aspect_status, "exact");
});

test("generation continues when the model catalog misreports channel unavailability", async (t) => {
  const root = await tempRoot(t);
  const image = makePng(1024, 1024);
  let catalogCalls = 0;
  let generationCalls = 0;
  const fakeFetch = async (url) => {
    if (url.endsWith("/models")) {
      catalogCalls += 1;
      return new Response(JSON.stringify({ error: { message: "暂无可用渠道" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    generationCalls += 1;
    return new Response(JSON.stringify({ data: [{ b64_json: image.toString("base64") }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await generateImage(config(root), {
    prompt: "catalog false positive",
    output: root,
  }, { fetchImpl: fakeFetch, catalogRetryDelayMs: 0 });

  assert.equal(catalogCalls, 2);
  assert.equal(generationCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.data.provider.model_catalog_status, "unverified");
  assert.equal(result.warnings[0].code, "model_catalog_unverified");
  assert.match(result.warnings[0].message, /继续.*真实生成/);
});

test("variant reference route false prompt errors get an actionable code", async (t) => {
  const root = await tempRoot(t);
  const referencePath = path.join(root, "reference.png");
  await fs.writeFile(referencePath, makePng(1024, 1024));
  const fakeFetch = async (url) => {
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [
        { id: "gpt-image-2" },
        { id: "gpt-image-2-high" },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: {
      code: "400",
      message: "prompt is required",
      type: "invalid_request_error",
    } }), { status: 400, headers: { "content-type": "application/json" } });
  };

  await assert.rejects(
    generateImage(config(root), {
      prompt: "keep composition",
      model: "gpt-image-2-high",
      reference: referencePath,
      output: root,
    }, { fetchImpl: fakeFetch }),
    (error) => {
      assert.equal(error.code, "reference_request_misparsed");
      assert.equal(error.details.prompt_was_sent, true);
      assert.match(error.nextActions[0], /Multipart/);
      return true;
    },
  );
});

test("output comparison reports format and count independently", () => {
  const result = compareOutput(
    { size: "1024x1024", outputFormat: "webp", count: 2 },
    [{ path: "x.png", size: "1024x1024", format: "png" }],
  );
  assert.deepEqual(result.deviations.map((item) => item.code), ["count_mismatch", "format_mismatch"]);
});

test("inspect validates real bytes", async (t) => {
  const root = await tempRoot(t);
  const imagePath = path.join(root, "image.anything");
  await fs.writeFile(imagePath, makePng(320, 240));
  const inspected = await inspectImageFile(imagePath);
  assert.equal(inspected.data.format, "png");
  assert.equal(inspected.data.size, "320x240");
  assert.equal(inspected.data.sha256.length, 64);
});

test("inspect reports a stable local error for a missing file", async (t) => {
  const root = await tempRoot(t);
  await assert.rejects(
    inspectImageFile(path.join(root, "missing.png")),
    (error) => {
      assert.equal(error.code, "image_not_found");
      assert.equal(error.status, 400);
      assert.equal(error.details.path, path.join(root, "missing.png"));
      return true;
    },
  );
});

test("reference input validation never reaches the upstream for invalid files", async (t) => {
  const root = await tempRoot(t);
  const invalidPath = path.join(root, "reference.txt");
  await fs.writeFile(invalidPath, "not an image", "utf8");
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    throw new Error("upstream must not be called for invalid local input");
  };

  await assert.rejects(
    generateImage(config(root), {
      prompt: "local validation",
      reference: invalidPath,
      output: root,
    }, { fetchImpl: fakeFetch }),
    (error) => {
      assert.equal(error.code, "invalid_reference_image");
      assert.equal(error.status, 400);
      return true;
    },
  );
  assert.equal(calls, 0);
});

test("reference input validation reports a missing file without leaking ENOENT", async (t) => {
  const root = await tempRoot(t);
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    throw new Error("upstream must not be called for a missing local input");
  };

  await assert.rejects(
    generateImage(config(root), {
      prompt: "missing reference",
      reference: path.join(root, "missing.png"),
      output: root,
    }, { fetchImpl: fakeFetch }),
    (error) => {
      assert.equal(error.code, "reference_image_not_found");
      assert.equal(error.status, 400);
      assert.doesNotMatch(error.message, /ENOENT/);
      return true;
    },
  );
  assert.equal(calls, 0);
});

test("channel-unavailable errors retain stable MCP guidance", async (t) => {
  const root = await tempRoot(t);
  let calls = 0;
  const fakeFetch = async (url) => {
    calls += 1;
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "gpt-image-2-high" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: { message: "暂无可用渠道" } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  };

  await assert.rejects(
    generateImage(config(root), { prompt: "test", output: root }, { fetchImpl: fakeFetch }),
    (error) => {
      const envelope = errorEnvelope("generate_image", error);
      assert.equal(envelope.error.code, "upstream_channel_unavailable");
      assert.equal(envelope.error.retryable, true);
      assert.equal(envelope.error.attempts, 1);
      assert.equal(envelope.error.diagnostics.phase, "generation_submit");
      assert.equal(envelope.error.diagnostics.target, "/images/generations");
      assert.match(envelope.next_actions.join("\n"), /Key提供方/);
      assert.match(envelope.next_actions.join("\n"), /不要.*提示词/);
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("invalid keys stop before a generation request", async (t) => {
  const root = await tempRoot(t);
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };

  await assert.rejects(
    generateImage(config(root), { prompt: "test", output: root }, { fetchImpl: fakeFetch }),
    (error) => {
      assert.equal(error.code, "invalid_api_key");
      assert.equal(error.retryable, false);
      assert.match(error.nextActions.join("\n"), /ResetApiKey/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("error envelopes redact bearer-like keys", () => {
  const secret = ["sk", "secretvalue123456789"].join("-");
  const result = errorEnvelope("test", new Error(`upstream echoed ${secret}`), [secret]);
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /secretvalue/);
});
