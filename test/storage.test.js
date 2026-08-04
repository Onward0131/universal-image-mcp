const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  createStorage,
  decodeDataUrl,
  extensionFor,
  formatFromContentType,
  imageDimensions,
  inspectImage,
  isPublicAddress,
} = require("../lib/storage");

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

function makeJpeg(width = 1, height = 1) {
  const size = Buffer.alloc(4);
  size.writeUInt16BE(height, 0);
  size.writeUInt16BE(width, 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08]),
    size,
    Buffer.from([0x01, 0x01, 0x11, 0x00]),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([0x00, 0xff, 0xd9]),
  ]);
}

function makeWebp(width = 1, height = 1) {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wawapi-storage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function apiResult(buffer, type = "base64") {
  return {
    attempts: 1,
    images: [{ type, value: type === "base64" ? buffer.toString("base64") : buffer, index: 0 }],
  };
}

function generationMeta(outputFormat = "png") {
  return {
    prompt: "test",
    model: "gpt-image-2",
    size: "1024x1024",
    quality: "medium",
    outputFormat,
    n: 2,
    elapsedMs: 10,
  };
}

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("storage normalizes image formats", () => {
  assert.equal(extensionFor("jpeg"), "jpg");
  assert.equal(extensionFor("WEBP"), "webp");
  assert.equal(extensionFor("unknown"), "png");
  assert.equal(formatFromContentType("image/jpeg"), "jpg");
});

test("readHistory backfills actual dimensions and format for existing image files", async (t) => {
  const root = await temporaryRoot(t);
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  await fs.mkdir(path.join(root, "output"), { recursive: true });

  await fs.writeFile(path.join(root, "output", "legacy.png"), makePng(1254, 1254));
  await fs.writeFile(
    path.join(root, "data", "history.json"),
    JSON.stringify([{ id: "legacy", images: [{ filename: "legacy.png", url: "/output/legacy.png" }] }]),
  );

  const [entry] = await createStorage(root).readHistory();
  assert.equal(entry.images[0].width, 1254);
  assert.equal(entry.images[0].height, 1254);
  assert.equal(entry.images[0].format, "png");
  assert.equal(entry.images[0].downloadUrl, "/api/download/legacy.png");
  assert.equal(entry.requestedCount, 1);
  assert.equal(
    Array.isArray(JSON.parse(await fs.readFile(path.join(root, "data", "history.backup.json"), "utf8"))),
    true,
  );
});

test("history recovers from an atomic backup and preserves the corrupt index", async (t) => {
  const root = await temporaryRoot(t);
  const storage = createStorage(root);
  const saved = await storage.saveGeneration(apiResult(makePng(320, 240)), generationMeta());
  const dataDir = path.join(root, "data");

  assert.equal(Array.isArray(JSON.parse(await fs.readFile(path.join(dataDir, "history.backup.json"), "utf8"))), true);
  await fs.writeFile(path.join(dataDir, "history.json"), "{not-json", "utf8");

  const recovered = await storage.readHistory();
  assert.equal(recovered[0].id, saved.id);
  assert.equal(storage.getHistoryNotice().kind, "backup_restored");
  assert.equal(Array.isArray(JSON.parse(await fs.readFile(path.join(dataDir, "history.json"), "utf8"))), true);
  assert.equal(
    (await fs.readdir(dataDir)).some((filename) => filename.startsWith("history.corrupt-") && filename.endsWith(".json")),
    true,
  );
});

test("history preserves an unreadable index even when no backup exists", async (t) => {
  const root = await temporaryRoot(t);
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "history.json"), "not-json", "utf8");
  const storage = createStorage(root);

  assert.deepEqual(await storage.readHistory(), []);
  assert.equal(storage.getHistoryNotice().kind, "corrupt_preserved");
  assert.equal(
    (await fs.readdir(dataDir)).some((filename) => filename.startsWith("history.corrupt-") && filename.endsWith(".json")),
    true,
  );
});

test("history refreshes a valid but stale backup from the primary index", async (t) => {
  const root = await temporaryRoot(t);
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "history.json"), JSON.stringify([{ id: "latest", images: [] }]), "utf8");
  await fs.writeFile(path.join(dataDir, "history.backup.json"), JSON.stringify([{ id: "older", images: [] }]), "utf8");

  const storage = createStorage(root);
  assert.equal((await storage.readHistory())[0].id, "latest");
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, "history.backup.json"), "utf8"))[0].id, "latest");
});

test("decodeDataUrl extracts image bytes", () => {
  const result = decodeDataUrl("data:image/png;base64,aGVsbG8=");
  assert.equal(result.extension, "png");
  assert.equal(result.buffer.toString("utf8"), "hello");
});

test("image inspection reads strict PNG, JPEG, and WebP headers", () => {
  assert.deepEqual(inspectImage(makePng(2048, 1152)), {
    format: "png",
    extension: "png",
    width: 2048,
    height: 1152,
  });
  assert.deepEqual(imageDimensions(makeJpeg(1024, 1536)), { width: 1024, height: 1536 });
  assert.deepEqual(imageDimensions(makeWebp(1000, 1500)), { width: 1000, height: 1500 });
  assert.equal(imageDimensions(Buffer.from("not an image")), null);
});

test("saveGeneration rejects invalid image bytes with a serializable 502 error", async (t) => {
  const root = await temporaryRoot(t);
  const storage = createStorage(root);

  await assert.rejects(
    storage.saveGeneration(apiResult(Buffer.from("this is not an image")), generationMeta()),
    (error) => error.status === 502 && error.code === "invalid_image_output",
  );
  assert.deepEqual(await fs.readdir(path.join(root, "output")), []);
});

test("saveGeneration names and records images using their real format", async (t) => {
  const root = await temporaryRoot(t);
  const storage = createStorage(root);
  const jpeg = makeJpeg(640, 480);

  const result = apiResult(jpeg);
  result.transport = "async";
  result.taskId = "imgtask_storage";
  result.pollCount = 4;
  const entry = await storage.saveGeneration(result, generationMeta("png"));
  const [saved] = entry.images;
  assert.match(saved.filename, /\.jpg$/);
  assert.equal(saved.format, "jpeg");
  assert.equal(saved.width, 640);
  assert.equal(saved.height, 480);
  assert.equal(entry.transport, "async");
  assert.equal(entry.taskId, "imgtask_storage");
  assert.equal(entry.pollCount, 4);
  assert.equal(entry.requestedCount, 2);
  assert.deepEqual(await fs.readFile(path.join(root, "output", saved.filename)), jpeg);
});

test("URL policy rejects loopback and private DNS results before fetching", async (t) => {
  const root = await temporaryRoot(t);
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error("fetch should not run");
  };

  const loopbackStorage = createStorage(root, { fetchImpl, lookup: publicLookup });
  await assert.rejects(
    loopbackStorage.saveGeneration(apiResult("http://127.0.0.1/image.png", "url"), generationMeta()),
    (error) => error.status === 502 && error.code === "unsafe_image_url",
  );

  const privateDnsStorage = createStorage(root, {
    fetchImpl,
    lookup: async () => [{ address: "10.20.30.40", family: 4 }],
  });
  await assert.rejects(
    privateDnsStorage.saveGeneration(apiResult("https://images.example/image.png", "url"), generationMeta()),
    (error) => error.status === 502 && error.code === "unsafe_image_url",
  );
  assert.equal(fetchCalls, 0);
});

test("URL policy validates every redirect hop", async (t) => {
  const root = await temporaryRoot(t);
  let fetchCalls = 0;
  const storage = createStorage(root, {
    lookup: publicLookup,
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(null, {
        status: 302,
        headers: { Location: "http://169.254.169.254/latest/meta-data" },
      });
    },
  });

  await assert.rejects(
    storage.saveGeneration(apiResult("https://images.example/image.png", "url"), generationMeta()),
    (error) => error.status === 502 && error.code === "unsafe_image_url",
  );
  assert.equal(fetchCalls, 1);
});

test("URL download has an explicit end-to-end timeout", async (t) => {
  const root = await temporaryRoot(t);
  const storage = createStorage(root, {
    lookup: publicLookup,
    downloadTimeoutMs: 20,
    fetchImpl: async (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      }),
  });

  await assert.rejects(
    storage.saveGeneration(apiResult("https://images.example/slow.png", "url"), generationMeta()),
    (error) => error.status === 502 && error.code === "image_download_timeout",
  );

  const dnsStorage = createStorage(root, {
    downloadTimeoutMs: 20,
    lookup: async () => new Promise(() => undefined),
    fetchImpl: async () => {
      throw new Error("fetch should not run before DNS completes");
    },
  });
  await assert.rejects(
    dnsStorage.saveGeneration(apiResult("https://dns-timeout.example/image.png", "url"), generationMeta()),
    (error) => error.status === 502 && error.code === "image_download_timeout",
  );
});

test("URL download enforces the byte limit while streaming", async (t) => {
  const root = await temporaryRoot(t);
  const storage = createStorage(root, {
    lookup: publicLookup,
    maxDownloadBytes: 8,
    fetchImpl: async () => new Response(Buffer.alloc(16), { status: 200 }),
  });

  await assert.rejects(
    storage.saveGeneration(apiResult("https://images.example/large.png", "url"), generationMeta()),
    (error) => error.status === 502 && error.code === "image_download_too_large",
  );
});

test("address policy rejects private, loopback, link-local, and mapped IPv6 addresses", () => {
  assert.equal(isPublicAddress("8.8.8.8", 4), true);
  assert.equal(isPublicAddress("127.0.0.1", 4), false);
  assert.equal(isPublicAddress("192.168.1.2", 4), false);
  assert.equal(isPublicAddress("169.254.1.2", 4), false);
  assert.equal(isPublicAddress("::1", 6), false);
  assert.equal(isPublicAddress("fe80::1", 6), false);
  assert.equal(isPublicAddress("fc00::1", 6), false);
  assert.equal(isPublicAddress("::ffff:127.0.0.1", 6), false);
  assert.equal(isPublicAddress("2606:4700:4700::1111", 6), true);
});
