const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ApiError,
  InputError,
  buildGenerationPayload,
  classifyNetworkError,
  createImageApi,
  decodeReferenceImage,
  MAX_REFERENCE_IMAGE_BYTES,
} = require("../lib/image-api");

const config = {
  baseUrl: "https://example.com/v1",
  apiKey: "secret",
  model: "gpt-image-2",
};

function referenceDataUrl(format = "png", size = 32, fill = 1) {
  const buffer = Buffer.alloc(size, fill);
  if (format === "png") {
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  } else if (format === "jpeg") {
    Buffer.from([0xff, 0xd8, 0xff]).copy(buffer);
  } else {
    buffer.write("RIFF", 0, "ascii");
    buffer.write("WEBP", 8, "ascii");
  }
  return `data:image/${format};base64,${buffer.toString("base64")}`;
}

test("buildGenerationPayload maps image controls", () => {
  assert.deepEqual(
    buildGenerationPayload({
      prompt: "test",
      model: "gpt-image-2",
      n: 2,
      size: "1024x1024",
      quality: "low",
      outputFormat: "webp",
      outputCompression: 85,
      background: "auto",
    }),
    {
      model: "gpt-image-2",
      prompt: "test",
      n: 2,
      size: "1024x1024",
      quality: "low",
      output_format: "webp",
      background: "auto",
      output_compression: 85,
    },
  );
});

test("buildGenerationPayload validates count", () => {
  assert.throws(
    () => buildGenerationPayload({ prompt: "test", n: 5 }),
    (error) => error instanceof InputError && error.status === 400 && error.code === "invalid_count",
  );
});

test("client lists models and parses base64 images", async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "gpt-image-2" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createImageApi(config, fakeFetch);

  assert.deepEqual(await client.listModels(), ["gpt-image-2"]);
  const generated = await client.generate({ prompt: "test", quality: "low" });
  assert.equal(generated.images[0].type, "base64");
  assert.equal(calls[1].options.headers.Authorization, "Bearer secret");
  assert.equal(JSON.parse(calls[1].options.body).model, "gpt-image-2");
});

test("client surfaces API errors without credentials", async () => {
  const fakeFetch = async () =>
    new Response(JSON.stringify({ error: { message: "Bad key", code: "invalid_api_key" } }), {
      status: 401,
      headers: { "x-request-id": "req_test" },
    });
  const client = createImageApi(config, fakeFetch);

  await assert.rejects(client.listModels(), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "invalid_api_key");
    assert.equal(error.requestId, "req_test");
    assert.equal(error.retryable, false);
    assert.match(error.nextActions.join("\n"), /ResetApiKey/);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
});

test("network failures retain safe cause codes and precise categories", async (t) => {
  const cases = [
    ["ENOTFOUND", "dns_resolution"],
    ["ECONNREFUSED", "connection_refused"],
    ["ECONNRESET", "connection_reset"],
    ["ETIMEDOUT", "connection_timeout"],
    ["CERT_HAS_EXPIRED", "tls_certificate"],
    ["ERR_PROXY_CONNECTION_FAILED", "proxy_connection"],
    ["ENETUNREACH", "network_unreachable"],
  ];

  for (const [causeCode, expectedCategory] of cases) {
    await t.test(causeCode, async () => {
      const cause = Object.assign(new Error(`safe ${causeCode}`), { code: causeCode });
      const fetchError = new TypeError("fetch failed");
      fetchError.cause = cause;
      assert.deepEqual(classifyNetworkError(fetchError), {
        category: expectedCategory,
        causeCode,
        causeName: "TypeError",
      });

      const client = createImageApi({
        ...config,
        catalogMaxRetries: 0,
        catalogRetryDelayMs: 0,
      }, async () => { throw fetchError; });
      await assert.rejects(client.listModels(), (error) => {
        assert.equal(error.code, "network_error");
        assert.equal(error.phase, "model_catalog");
        assert.equal(error.target, "/models");
        assert.equal(error.networkCategory, expectedCategory);
        assert.equal(error.causeCode, causeCode);
        assert.equal(error.details.network_category, expectedCategory);
        assert.match(error.nextActions.join("\n"), /不.*直接解释.*渠道不可用/);
        return true;
      });
    });
  }
});

test("catalog timeout is identified without claiming a generation-channel outage", async () => {
  const client = createImageApi({
    ...config,
    catalogTimeoutMs: 10,
    catalogMaxRetries: 0,
  }, async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
  }));

  await assert.rejects(client.listModels(), (error) => {
    assert.equal(error.code, "upstream_timeout");
    assert.equal(error.phase, "model_catalog");
    assert.equal(error.networkCategory, "timeout");
    assert.match(error.message, /模型目录探测/);
    return true;
  });
});

test("explicit authentication failures normalize to invalid_api_key", async (t) => {
  const cases = [
    { status: 401, message: "Access denied" },
    { status: 403, message: "Authentication failed" },
    { status: 403, message: "API Key已过期" },
  ];

  for (const item of cases) {
    await t.test(`${item.status} ${item.message}`, async () => {
      const client = createImageApi(config, async () => new Response(JSON.stringify({
        error: { message: item.message },
      }), {
        status: item.status,
        headers: { "content-type": "application/json" },
      }));
      await assert.rejects(client.listModels(), (error) => {
        assert.equal(error.code, "invalid_api_key");
        assert.equal(error.retryable, false);
        assert.match(error.nextActions.join("\n"), /Key/);
        return true;
      });
    });
  }
});

test("client sends reference images to the edits endpoint as multipart data", async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createImageApi(config, fakeFetch);
  const dataUrl = referenceDataUrl("png");

  const edited = await client.edit({
    prompt: "keep the composition",
    quality: "low",
    outputFormat: "png",
    referenceImage: { dataUrl, name: "source.png" },
  });

  assert.equal(edited.images[0].type, "base64");
  assert.equal(calls[0].url, "https://example.com/v1/images/edits");
  assert.ok(calls[0].options.body instanceof FormData);
  assert.equal(calls[0].options.body.get("model"), "gpt-image-2");
  assert.equal(calls[0].options.body.get("prompt"), "keep the composition");
  assert.equal(calls[0].options.body.get("image").name, "source.png");
  assert.deepEqual([...calls[0].options.body.keys()].slice(0, 3), ["prompt", "model", "n"]);
  assert.equal(calls[0].options.headers["Content-Type"], undefined);
});

test("decodeReferenceImage validates image data URLs", () => {
  const dataUrl = referenceDataUrl("webp", 32, 2);
  const image = decodeReferenceImage({ dataUrl, name: "reference.webp" });
  assert.equal(image.mimeType, "image/webp");
  assert.equal(image.buffer.length, 32);
  assert.throws(() => decodeReferenceImage({ dataUrl: "data:text/plain;base64,YQ==" }), /PNG/);
  assert.throws(
    () => decodeReferenceImage({ dataUrl: referenceDataUrl("png").replace("image/png", "image/jpeg") }),
    (error) => error.status === 400 && error.code === "invalid_reference_image",
  );
});

test("reference image size follows the provider 10 MB limit", () => {
  const accepted = referenceDataUrl("png", MAX_REFERENCE_IMAGE_BYTES);
  assert.equal(decodeReferenceImage({ dataUrl: accepted }).buffer.length, MAX_REFERENCE_IMAGE_BYTES);
  const rejected = referenceDataUrl("png", MAX_REFERENCE_IMAGE_BYTES + 1);
  assert.throws(() => decodeReferenceImage({ dataUrl: rejected }), /10 MB/);
});

test("generation and editing never replay capacity failures", async () => {
  for (const operation of ["generate", "edit"]) {
    let calls = 0;
    const client = createImageApi(config, async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "No available compatible accounts" } }), { status: 503 });
    });
    await assert.rejects(client[operation]({ prompt: "single submission", maxRetries: 5, referenceImage: { dataUrl: referenceDataUrl("png"), name: "source.png" } }), { code: "upstream_channel_unavailable", attempts: 1 });
    assert.equal(calls, 1);
  }
});

test("channel-unavailable messages normalize across English and Chinese responses", async (t) => {
  const messages = [
    "No available channel",
    "No available compatible accounts",
    "Channel unavailable",
    "渠道不可用",
    "无可用渠道",
    "没有可用渠道",
    "暂无可用渠道",
    "无可用兼容账号",
  ];

  for (const message of messages) {
    await t.test(message, async () => {
      let calls = 0;
      const client = createImageApi(config, async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      });

      await assert.rejects(client.generate({ prompt: "channel test", retryDelayMs: 0 }), (error) => {
        assert.equal(error.code, "upstream_channel_unavailable");
        assert.equal(error.retryable, true);
        assert.equal(error.attempts, 1);
        assert.match(error.nextActions.join("\n"), /渠道恢复/);
        assert.match(error.nextActions.join("\n"), /Key提供方/);
        assert.match(error.nextActions.join("\n"), /不要.*提示词/);
        return true;
      });
      assert.equal(calls, 1);
    });
  }
});

test("generic image 502 and 503 responses stay classified as transient upstream failures", async (t) => {
  for (const status of [502, 503]) {
    await t.test(`HTTP ${status}`, async () => {
      let calls = 0;
      const fakeFetch = async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: "Temporary upstream gateway failure" } }), {
          status,
          headers: { "content-type": "application/json" },
        });
      };
      const client = createImageApi(config, fakeFetch);

      await assert.rejects(
        client.generate({ prompt: "transient gateway" }),
        (error) => {
          assert.equal(error.code, "upstream_error");
          assert.equal(error.status, status);
          assert.equal(error.attempts, 1);
          assert.equal(error.retryable, true);
          assert.match(error.nextActions.join("\n"), /不要自动重放/);
          return true;
        },
      );
      assert.equal(calls, 1);
    });
  }
});

test("reference edits do not automatically replay an ambiguous 524 timeout", async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return new Response(null, { status: 524 });
  };
  const client = createImageApi(config, fakeFetch);
  const dataUrl = referenceDataUrl("png", 32, 4);

  await assert.rejects(
    client.edit({ prompt: "timeout", referenceImage: { dataUrl, name: "source.png" } }),
    (error) => {
      assert.equal(error.code, "upstream_timeout");
      assert.equal(error.status, 524);
      assert.equal(error.attempts, 1);
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("reference edit multipart fields cover every supported size, quality, and format", async () => {
  const forms = [];
  const fakeFetch = async (_url, options) => {
    forms.push(options.body);
    return new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createImageApi(config, fakeFetch);
  const dataUrl = referenceDataUrl("png", 32, 5);
  const sizes = [
    "1024x1024",
    "1536x1024",
    "1024x1536",
    "2048x1080",
    "2048x1152",
    "2048x2048",
    "2560x1440",
    "3840x2160",
    "4096x2160",
    "4096x2304",
    "4096x4096",
    "auto",
  ];
  const qualities = ["low", "medium", "high", "auto"];
  const formats = ["png", "jpeg", "webp"];

  for (const size of sizes) {
    for (const quality of qualities) {
      for (const outputFormat of formats) {
        await client.edit({
          prompt: "matrix",
          size,
          quality,
          outputFormat,
          outputCompression: 87,
          referenceImage: { dataUrl, name: "matrix.png" },
        });
        const form = forms.at(-1);
        assert.equal(form.get("size"), size === "auto" ? null : size);
        assert.equal(form.get("quality"), quality);
        assert.equal(form.get("output_format"), outputFormat);
        assert.equal(form.get("image").name, "matrix.png");
        assert.equal(form.get("output_compression"), outputFormat === "png" ? null : "87");
      }
    }
  }
  assert.equal(forms.length, sizes.length * qualities.length * formats.length);
});

test("client normalizes rejected resolution errors", async () => {
  const fakeFetch = async () => new Response(JSON.stringify({
    error: { message: "Invalid size: must be one of the supported sizes", code: "invalid_value" },
  }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
  const client = createImageApi(config, fakeFetch);

  await assert.rejects(
    client.generate({ prompt: "4k", size: "4096x4096", maxRetries: 0 }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "unsupported_size");
      assert.equal(error.message, "上游不支持请求的图片尺寸");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});
