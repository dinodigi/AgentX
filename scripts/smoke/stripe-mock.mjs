import http from "node:http";
import { randomBytes } from "node:crypto";

/**
 * In-process fake Stripe API for the smoke suite (K2b). The dev server routes
 * to it by setting STRIPE_API_BASE=http://localhost:4242 in .env, so it must
 * listen on that fixed port. Fakes:
 *   POST /v1/checkout/sessions → deterministic {id, url}, records the form body
 *   GET  /v1/account           → {id: acct_test} (connector health)
 * Every request (method, path, parsed form fields) is captured for assertions.
 */
export const STRIPE_MOCK_PORT = 4242;

export async function startStripeMock(port = STRIPE_MOCK_PORT) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const form = Object.fromEntries(new URLSearchParams(raw));
      requests.push({ method: req.method, path: req.url, form, auth: req.headers.authorization });
      const send = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "POST" && req.url === "/v1/checkout/sessions") {
        // A cart containing the magic price id gets a 200 with an unreadable
        // body — the "2xx then truncated/garbage" upstream fault class.
        if (Object.values(form).includes("price_badbody")) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end("not json {{{");
        }
        const id = "cs_test_" + randomBytes(8).toString("hex");
        return send(200, {
          id,
          url: `https://checkout.stripe.com/c/pay/${id}`,
          mode: form.mode,
          payment_status: "unpaid",
        });
      }
      if (req.method === "GET" && req.url.startsWith("/v1/account")) {
        return send(200, { id: "acct_test", object: "account" });
      }
      // Anything else: mimic Stripe's error envelope.
      send(404, { error: { message: `mock: no route for ${req.method} ${req.url}` } });
    });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reset: () => (requests.length = 0),
    close: () => new Promise((r) => server.close(r)),
  };
}
