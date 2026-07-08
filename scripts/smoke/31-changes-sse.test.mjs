import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, BASE } from "./helpers.mjs";

// H4: SSE change stream — same auth + intersection gate as H2, bounded lifetime,
// resume via ?since / Last-Event-ID. The ?maxMs= override keeps this smoke short.
describe("change feed SSE stream (H4)", () => {
  let p;

  function parseFrame(raw) {
    const out = { event: "message" };
    for (const line of raw.split("\n")) {
      if (line.startsWith("id:")) out.id = line.slice(3).trim();
      else if (line.startsWith("event:")) out.event = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        try {
          out.data = JSON.parse(line.slice(5).trim());
        } catch {
          out.data = line.slice(5).trim();
        }
      } else if (line.startsWith(":")) out.comment = true;
    }
    return out;
  }

  async function readStream(path, ms) {
    const res = await fetch(`${BASE}/api/v1${path}`, {
      headers: { authorization: `Bearer ${p.deliveryToken}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const frames = [];
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        frames.push(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
      }
    }
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    return frames.map(parseFrame);
  }

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("changes-sse");
    const d = await mcp(p.mcpToken, "define_collection", {
      name: "live",
      fields: [{ name: "title", label: "T", type: "text", required: true, publicRead: true }],
    });
    assert.ok(d.ok, d.errorText);
  });
  after(async () => {
    await p.destroy();
  });

  it("streams a change frame for a concurrent write, then closes with a cursor frame", async () => {
    // Fire a create ~1.5s after opening (stream is polling; hold-back is 2s).
    const createSoon = (async () => {
      await new Promise((r) => setTimeout(r, 1500));
      return mcp(p.mcpToken, "create_entry", { collection: "live", data: { title: "streamed" } });
    })();

    const frames = await readStream("/changes/stream?maxMs=6000", 9000);
    const created = await createSoon;

    const change = frames.find((f) => f.event === "change" && f.data?.id === created.value.id);
    assert.ok(change, "a change frame arrived for the concurrent write");
    assert.equal(change.data.kind, "created");
    assert.equal(change.data.data.title, "streamed");
    assert.ok(change.id, "the frame carries an id: (the resume cursor)");

    const cursorFrame = frames.find((f) => f.event === "cursor");
    assert.ok(cursorFrame, "a bounded stream closes cleanly with a cursor frame");
    assert.ok(cursorFrame.data.cursor, "the cursor frame carries a resume cursor");
  });

  it("a bad ?since is 422 (not a broken stream)", async () => {
    const res = await fetch(`${BASE}/api/v1/changes/stream?since=nope`, {
      headers: { authorization: `Bearer ${p.deliveryToken}` },
    });
    assert.equal(res.status, 422);
    try {
      await res.body?.cancel();
    } catch {
      /* noop */
    }
  });
});
