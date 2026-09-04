// A stub MCP index backend, for the recorded demo.
//
// The demo must not depend on a real backend: a real one needs a vector store
// and an embedding model, takes minutes, and would put whoever recorded it
// their own hostnames into a public GIF. This speaks just enough MCP to be
// driven by codeindex-sync, and keeps its "index" in a JSON file.
//
// It is also the honest way to show the central claim — that a backend is
// config rather than code. Nothing here is special-cased anywhere in src/.
import { readFileSync, writeFileSync } from "node:fs";

const STATE = process.argv[2];

const load = () => {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return { chunks: 0, files: 0 };
  }
};
const save = (s) => writeFileSync(STATE, JSON.stringify(s), "utf8");

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const text = (id, t) =>
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: t }] } });

function handle(msg) {
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
  }
  if (msg.method !== "tools/call") return;

  const name = msg.params?.name;
  const project = msg.params?.arguments?.projectPath ?? "(unknown)";
  const state = load();

  if (name === "update_index") {
    // A believable incremental result: a couple of files, a few chunks.
    const added = 1 + Math.floor(Math.random() * 3);
    const chunks = added * (7 + Math.floor(Math.random() * 9));
    save({ chunks: state.chunks + chunks, files: state.files + added });
    return text(
      msg.id,
      [
        `Updated project index: ${project}`,
        `Added: ${added}`,
        `Updated: 0`,
        `Removed: 0`,
        `New chunks: ${chunks}`,
      ].join("\n"),
    );
  }

  if (name === "rebuild_index") {
    save({ chunks: 412, files: 34 });
    return text(msg.id, `Rebuilt index for ${project}\nFiles: 34\nChunks: 412`);
  }

  if (name === "index_status") {
    return text(
      msg.id,
      [
        `Project: ${project}`,
        `Collection: demo_notes`,
        `Status: green`,
        `Indexed chunks: ${state.chunks}`,
      ].join("\n"),
    );
  }

  if (name === "list_indexes") {
    return text(
      msg.id,
      [
        "Indexed projects:",
        "",
        `  - ${process.env.DEMO_REPO ?? project}`,
        "    Collection: demo_notes",
        `    Files: ${state.files}`,
      ].join("\n"),
    );
  }

  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `no such tool: ${name}` } });
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // Not JSON: ignore, exactly as a real server's banner would be ignored.
    }
  }
});
