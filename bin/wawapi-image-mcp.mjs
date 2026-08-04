#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import path from "node:path";
import { fileURLToPath } from "node:url";

import bridge from "../lib/bridge.js";
import configModule from "../lib/mcp-config.js";
import packageJson from "../package.json" with { type: "json" };

const {
  doctor,
  errorEnvelope,
  explain,
  generateImage,
  inspectImageFile,
  listModels,
} = bridge;
const { resolveMcpConfig } = configModule;

function currentConfig() {
  return resolveMcpConfig();
}

function textResult(envelope, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    ...(isError ? { isError: true } : {}),
  };
}

function toolHandler(command, callback) {
  return async (args = {}) => {
    const config = currentConfig();
    try {
      return textResult(await callback(config, args));
    } catch (error) {
      return textResult(errorEnvelope(command, error, [config.apiKey]), true);
    }
  };
}

export function createWawapiImageMcpServer() {
  const server = new McpServer({
    name: "wawapi-image-mcp",
    version: packageJson.version,
  });

  server.registerTool("image_doctor", {
    title: "Check image bridge",
    description: "Check local runtime and credentials, then optionally probe the read-only Wawapi model catalog. It never generates or uploads an image and cannot prove whether the billable image-generation channel is currently available.",
    inputSchema: {
      probe_catalog: z.boolean().default(true).describe("Set false for an offline local-only check that does not validate the Key or contact Wawapi"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, toolHandler("image_doctor", (config, args) => doctor(config, {
    probeCatalog: args.probe_catalog,
  })));

  server.registerTool("list_image_models", {
    title: "List image models",
    description: "List the image models currently exposed by the configured Wawapi endpoint. This is a read-only discovery call.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, toolHandler("list_image_models", (config) => listModels(config)));

  server.registerTool("explain_image_capability", {
    title: "Explain image capability",
    description: "Explain model selection and time-point evidence for a requested size, format, count, and optional reference image. Use before 2K, 4K, non-PNG, multiple-image, or reference-image work. This does not generate an image.",
    inputSchema: {
      model: z.string().default("auto").describe("Image model id or auto"),
      size: z.string().default("1024x1024").describe("Requested size such as 1024x1024 or 3840x2160"),
      format: z.enum(["png", "jpeg", "webp"]).default("png"),
      count: z.number().int().min(1).max(4).default(1).describe("Requested number of independent image files"),
      has_reference_image: z.boolean().default(false),
      offline: z.boolean().default(false).describe("Use bundled historical evidence without model discovery. Do not present its selected model as the current catalog-aware auto choice."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, toolHandler("explain_image_capability", (config, args) => explain(config, {
    model: args.model,
    size: args.size,
    format: args.format,
    count: args.count,
    hasReferenceImage: args.has_reference_image,
    offline: args.offline,
  })));

  const generationSchema = {
    prompt: z.string().min(1).max(32000).describe("Complete image-generation instruction"),
    model: z.string().default("auto").describe("Image model id or auto"),
    size: z.string().default("1024x1024"),
    quality: z.enum(["low", "medium", "high", "auto"]).default("low"),
    format: z.enum(["png", "jpeg", "webp"]).default("png"),
    count: z.number().int().min(1).max(4).default(1),
    out: z.string().optional().describe("Output file or directory. Relative paths resolve from the MCP process working directory."),
  };

  server.registerTool("generate_image", {
    title: "Generate image",
    description: "Generate and save image files through Wawapi when the user explicitly asks for an image. This is a live, potentially billable request. The bridge allows 300 seconds for the generation response, while the installer configures Codex to allow 600 seconds for the complete tool call and file-save overhead. If the host cancels or times out, do not retry or switch tools without fresh user authorization. The result is deliberately text-only JSON with absolute paths and Markdown; it never returns an MCP image content block, so text-only model APIs can call it safely.",
    inputSchema: generationSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, toolHandler("generate_image", (config, args) => generateImage(config, {
    prompt: args.prompt,
    model: args.model,
    size: args.size,
    quality: args.quality,
    format: args.format,
    count: args.count,
    output: args.out,
  })));

  server.registerTool("edit_image", {
    title: "Edit image from reference",
    description: "Generate a new image from a local PNG, JPEG, or WebP reference when the user explicitly requests an edit or transformation. This is a live, potentially billable request. The bridge allows 300 seconds for the generation response, while the installer configures Codex to allow 600 seconds for the complete tool call and file-save overhead. If the host cancels or times out, do not retry or switch tools without fresh user authorization. It returns text-only JSON and local paths, not image content blocks.",
    inputSchema: {
      ...generationSchema,
      reference_path: z.string().min(1).describe("Local path to a PNG, JPEG, or WebP file up to 10 MB"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, toolHandler("edit_image", (config, args) => generateImage(config, {
    prompt: args.prompt,
    model: args.model,
    size: args.size,
    quality: args.quality,
    format: args.format,
    count: args.count,
    output: args.out,
    reference: args.reference_path,
  })));

  server.registerTool("inspect_image", {
    title: "Inspect saved image",
    description: "Validate a local PNG, JPEG, or WebP and return its real format, dimensions, byte count, SHA-256, absolute path, file URI, and Markdown. This does not send the image to a model or network service.",
    inputSchema: {
      path: z.string().min(1).describe("Local image path"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, toolHandler("inspect_image", (_config, args) => inspectImageFile(args.path)));

  return server;
}

async function main() {
  const server = createWawapiImageMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`wawapi-image-mcp ${packageJson.version} listening on stdio\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`MCP server error: ${String(error?.message || error)}\n`);
    process.exit(1);
  });
}
