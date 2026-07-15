import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, connectResend, mcp, deliveryLog } from "./helpers.mjs";

// Styled HTML email: the email action's optional `html` template renders a
// designed body, interpolates {{field}} from entry data, and HTML-ESCAPES the
// values so a submitted field can't inject markup into the branded email.
describe("email: styled html template + escaping", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("email-html");
    await connectResend(p.id);
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "orders",
      fields: [
        { name: "email", label: "Email", type: "text", required: true },
        { name: "name", label: "Name", type: "text" },
      ],
      events: {
        created: [
          {
            type: "email",
            to: "{{email}}",
            subject: "Order for {{name}}",
            html: '<h1>Thanks, {{name}}!</h1><p>Your order is in.</p>',
          },
        ],
      },
    });
    assert.ok(def.ok, def.errorText);
  });
  after(() => p.destroy());

  const findEmail = async () => {
    for (let i = 0; i < 20; i++) {
      const rows = await deliveryLog(p.id);
      const row = rows.find((r) => String(r.url).startsWith("email:"));
      if (row) return row;
      await new Promise((r) => setTimeout(r, 750));
    }
    return null;
  };

  it("renders the html body, interpolated and escaped; text fallback derived", async () => {
    // `name` carries HTML metacharacters — the escaping is the security point.
    const c = await mcp(p.mcpToken, "create_entry", {
      collection: "orders",
      data: { email: "buyer@example.com", name: "Ada <script>x</script> & Co" },
    });
    assert.ok(c.ok, c.errorText);

    const row = await findEmail();
    assert.ok(row, "an email delivery should be logged");
    const email = row.payload?.email;
    assert.ok(email, "the logged payload carries the rendered email");

    // Styled: the template markup is present.
    assert.ok(email.html.includes("<h1>Thanks,"), "html body rendered");
    // Escaped: the submitted value is neutralized, never raw markup.
    assert.ok(email.html.includes("Ada &lt;script&gt;x&lt;/script&gt; &amp; Co"), email.html);
    assert.ok(!email.html.includes("<script>x</script>"), "raw script must not survive");
    // Text fallback: tags stripped, still readable.
    assert.ok(email.text.includes("Thanks, Ada"), email.text);
    assert.ok(!email.text.includes("<h1>"), "text fallback has no tags");
    // Recipient still interpolated from entry data.
    assert.equal(email.to, "buyer@example.com");
  });
});
