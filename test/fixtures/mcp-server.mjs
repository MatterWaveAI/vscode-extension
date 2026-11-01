// A stdio MCP server for the tests: newline-delimited JSON-RPC on stdin and
// stdout, three tools, and a log of every tools/call to stderr.
import { createInterface } from "node:readline";

const TOOLS = [
  { name: "read_thing", description: "Read a thing.", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "write_thing", description: "Write a thing.", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
  { name: "secret_tool", description: "Never offered: outside the allow-list.", inputSchema: { type: "object", properties: {} } },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    case "tools/list":
      return send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
    case "tools/call":
      process.stderr.write(`called ${message.params.name}\n`);
      return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `${message.params.name}(${JSON.stringify(message.params.arguments)})` }] } });
    default:
      return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no such method" } });
  }
});
