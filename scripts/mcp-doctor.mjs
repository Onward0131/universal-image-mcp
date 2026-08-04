import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import packageJson from "../package.json" with { type: "json" };

const REQUIRED_TOOLS = [
  "image_doctor",
  "list_image_models",
  "explain_image_capability",
  "generate_image",
  "edit_image",
  "inspect_image",
];

const command = process.argv[2];
if (!command) throw new Error("Pass the wawapi-image-mcp command path as argv[2]");
const stateRoot = process.argv[3] || process.env.WAWAPI_IMAGE_HOME;
if (!stateRoot) throw new Error("Pass the MCP state directory as argv[3] or WAWAPI_IMAGE_HOME");
const offline = process.argv.includes("--offline");

const transport = new StdioClientTransport({
  command,
  env: {
    ...process.env,
    WAWAPI_IMAGE_HOME: stateRoot,
  },
  stderr: "pipe",
});
const client = new Client({ name: "wawapi-image-mcp-doctor", version: packageJson.version });

function parseTextEnvelope(response, toolName) {
  if (response.isError) throw new Error(`${toolName} failed: ${response.content[0]?.text || "unknown error"}`);
  if (!response.content.length || response.content.some((item) => item.type !== "text")) {
    throw new Error(`${toolName} returned a non-text MCP content block`);
  }
  return JSON.parse(response.content[0].text);
}

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const toolNames = listed.tools.map((tool) => tool.name);
  const missing = REQUIRED_TOOLS.filter((name) => !toolNames.includes(name));
  const unexpected = toolNames.filter((name) => !REQUIRED_TOOLS.includes(name));
  if (missing.length || unexpected.length) {
    throw new Error(`Unexpected MCP tools; missing=${missing.join(",")}; unexpected=${unexpected.join(",")}`);
  }

  const doctorResponse = await client.callTool({
    name: "image_doctor",
    arguments: { probe_catalog: !offline },
  });
  const capabilityResponse = await client.callTool({
    name: "explain_image_capability",
    arguments: { size: "3840x2160", offline: true },
  });
  const doctor = parseTextEnvelope(doctorResponse, "image_doctor");
  const capability = parseTextEnvelope(capabilityResponse, "explain_image_capability");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    tools: toolNames,
    ready: Boolean(doctor.data?.ready),
    issues: doctor.data?.issues || [],
    warnings: doctor.warnings || [],
    checks: doctor.data?.checks || {},
    catalog_status: doctor.data?.catalog_status || "unknown",
    generation_channel_status: doctor.data?.generation_channel_status || "unknown",
    selected_model: capability.data?.explanation?.selectedModel || null,
    content_types: ["text"],
  })}\n`);
} finally {
  await client.close();
}
