import fs from "node:fs";
import path from "node:path";

// Minimal CLI double for the isolated installer test. No secondary shell host.
if (!process.env.CODEX_HOME) throw new Error("CODEX_HOME is required");
const file = path.join(process.env.CODEX_HOME, "config.toml");
const args = process.argv.slice(2);
if (args[0] !== "mcp") throw new Error("Unsupported test command");
let lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
const start = lines.findIndex((line) => line.trim() === "[mcp_servers.universal-image]");
let end = start < 0 ? -1 : lines.findIndex((line, i) => i > start && /^\[/.test(line.trim()) && !line.trim().startsWith("[mcp_servers.universal-image"));
if (start >= 0 && end < 0) end = lines.length;
const remove = () => { if (start >= 0) lines.splice(start, end - start); };
const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${lines.join("\n").trim()}\n`); };
const quote = (value) => `'${value}'`;

if (args[1] === "get") {
  if (start < 0) process.exit(1);
  let command = "", timeout = null, envVars = [], inEnv = false;
  const env = {};
  for (const line of lines.slice(start + 1, end)) {
    if (line.trim() === "[mcp_servers.universal-image.env]") { inEnv = true; continue; }
    const m = /^\s*([\w-]+)\s*=\s*(.+)\s*$/.exec(line);
    if (!m) continue;
    const value = m[2].trim();
    const parsed = value.startsWith("'") ? value.slice(1, -1) : JSON.parse(value);
    if (inEnv) env[m[1]] = parsed;
    else if (m[1] === "command") command = parsed;
    else if (m[1] === "tool_timeout_sec") timeout = parsed;
    else if (m[1] === "env_vars") envVars = parsed;
  }
  console.log(JSON.stringify({ name: "universal-image", enabled: true, transport: { type: "stdio", command, args: [], env, env_vars: envVars, cwd: null }, tool_timeout_sec: timeout }));
} else if (args[1] === "remove") {
  if (start < 0) process.exit(1);
  remove(); save();
} else if (args[1] === "add") {
  let i = 2;
  const env = {};
  while (args[i] === "--env") {
    const index = args[i + 1].indexOf("=");
    if (index < 1) throw new Error("Invalid assignment");
    env[args[i + 1].slice(0, index)] = args[i + 1].slice(index + 1);
    i += 2;
  }
  if (args[i] !== "universal-image" || args[i + 1] !== "--" || !args[i + 2]) throw new Error("Invalid add command");
  remove();
  lines.push("", "[mcp_servers.universal-image]", `command = ${quote(args[i + 2])}`, "", "[mcp_servers.universal-image.env]");
  for (const [name, value] of Object.entries(env)) lines.push(`${name} = ${quote(value)}`);
  save();
} else throw new Error("Unsupported MCP action");
