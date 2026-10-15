import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_TOOL_TIMEOUT_MS = 600_000;
const installedCommand = process.argv[2] === "-" ? null : process.argv[2];
const outputPath = path.resolve(process.argv[3] || path.join(root, "generated-images", "live-mcp.png"));
const transport = new StdioClientTransport(installedCommand ? {
  command: installedCommand,
  env: process.env,
  stderr: "pipe",
} : {
  command: process.execPath,
  args: [path.join(root, "bin", "universal-image-mcp.mjs")],
  cwd: root,
  env: process.env,
  stderr: "pipe",
});

const client = new Client({ name: "universal-image-mcp-live-smoke", version: packageJson.version });
try {
  await client.connect(transport);
  const doctor = await client.callTool({ name: "image_doctor", arguments: {} });
  const doctorEnvelope = JSON.parse(doctor.content[0].text);
  if (!doctorEnvelope.data?.ready) throw new Error(`MCP doctor not ready: ${doctor.content[0].text}`);

  const editReference = process.env.IMAGE_LIVE_EDIT_REFERENCE;
  const generated = await client.callTool(
    {
      name: editReference ? "edit_image" : "generate_image",
      arguments: {
        prompt: editReference ? "Edit this reference image: change the red paper crane to blue. Preserve its folded paper shape, white studio background, centered composition and soft shadow. No text." : "A precise acceptance-test image: a red paper crane on a white studio background, centered composition, soft shadow, no text",
        size: "1024x1024",
        format: "png",
        count: 1,
        out: outputPath,
        ...(editReference ? { reference_path: path.resolve(editReference) } : {}),
      },
    },
    undefined,
    { timeout: LIVE_TOOL_TIMEOUT_MS, maxTotalTimeout: LIVE_TOOL_TIMEOUT_MS },
  );
  if (generated.isError) throw new Error(generated.content[0]?.text || "MCP generation failed");
  if (generated.content.some((item) => item.type !== "text")) {
    throw new Error("MCP returned a non-text content block");
  }
  const result = JSON.parse(generated.content[0].text);
  const reportPath = `${outputPath}.json`;
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: result.ok, tool: editReference ? "edit_image" : "generate_image", model: result.data.request.model, provider: result.data.provider, result: result.data.result, report: reportPath })}\n`);
} finally {
  await client.close();
}
