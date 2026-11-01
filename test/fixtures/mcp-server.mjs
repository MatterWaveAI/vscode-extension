// A stdio MCP server for the tests: newline-delimited JSON-RPC on stdin and
// stdout, three tools, and a log of every tools/call to stderr. Its first
// argument picks a misbehaviour for the tests of what a server may send:
//   flood   answers initialize with one line of 9 MB and no newline
//   many    lists 300 tools, one with a 50 KB schema and two whose names clean to one
//   env     its read_thing returns the names of the environment it was started with
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "";

const TOOLS = [
  { name: "read_thing", description: "Read a thing.", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "write_thing", description: "Write a thing.", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
  { name: "secret_tool", description: "Never offered: outside the allow-list.", inputSchema: { type: "object", properties: {} } },
];

function manyTools() {
  const huge = { type: "object", properties: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`p${i}`, { type: "string", description: "x".repeat(10) }])) };
  return [
    { name: "a.b", description: "dotted", inputSchema: { type: "object" } },
    { name: "a_b", description: "underscored", inputSchema: { type: "object" } },
    { name: "huge_schema", description: "too big", inputSchema: huge },
    ...Array.from({ length: 300 }, (_, i) => ({ name: `t${i}`, description: "", inputSchema: { type: "object" } })),
  ];
}

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
      if (mode === "flood") {
        process.stdout.write(`{"jsonrpc":"2.0","id":${message.id},"result":{"x":"${"y".repeat(9 * 1024 * 1024)}`);
        return;
      }
      return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    case "tools/list":
      return send({ jsonrpc: "2.0", id: message.id, result: { tools: mode === "many" ? manyTools() : TOOLS } });
    case "tools/call":
      process.stderr.write(`called ${message.params.name}\n`);
      if (mode === "env") {
        return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: Object.keys(process.env).sort().join("\n") }] } });
      }
      return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `${message.params.name}(${JSON.stringify(message.params.arguments)})` }] } });
    default:
      return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no such method" } });
  }
});
