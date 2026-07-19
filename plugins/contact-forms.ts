import type { PluginDef } from "@/lib/plugins";

/**
 * Contact forms — first-party BUILT-IN plugin (structure + guidance only, no
 * extra tools). A structure-only plugin is what people loosely call a
 * "template" — same install mechanism.
 */
export const CONTACT_FORMS_PLUGIN: PluginDef = {
  id: "contact_forms",
  version: "1.0.0",
  name: "Contact forms",
  description:
    "Production contact/lead-capture model: a publicWrite inbox with moderation, webhook/email notification — structure + guidance, no extra tools.",
  structure: {
    intent:
      "The project can receive contact-form submissions from its live site: an inbox collection " +
      "that anonymous visitors can POST to, whose rows appear in the admin, with a moderation " +
      "status the submitter can never set.",
    baseline: [
      {
        name: "inbox",
        displayName: "Inbox",
        publicWrite: true,
        fields: [
          { name: "name", label: "Name", type: "text", required: true },
          { name: "email", label: "Email", type: "text", required: true, max: 320 },
          { name: "message", label: "Message", type: "richtext", required: true, max: 10000 },
          {
            name: "status",
            label: "Status",
            type: "enum",
            options: ["new", "replied", "archived"],
            writableBy: "none",
          },
        ],
      },
    ],
    reconcile:
      "If the project already has a form/inbox-shaped collection (publicWrite with an email " +
      "field), EXTEND it — add the missing fields and the status enum — instead of creating a " +
      "second inbox. Match the project's existing naming style. Add the project-specific fields " +
      "its forms actually send (phone, company, budget…). Never make submitter PII publicRead.",
  },
  guidance:
    "A form = a publicWrite collection: the site POSTs to /v1/{collection} with the delivery " +
    "token. Set webhookUrl on the collection (define_collection) or an email action to get " +
    "notified per submission. Submitter fields stay writable; moderation fields are " +
    "writableBy:'none' so an anonymous POST can never set them.",
  acceptance: [
    "a publicWrite collection exists with required name + email + message fields",
    "its moderation/status field is writableBy:'none' (an anonymous POST setting it is rejected 403)",
    "an anonymous POST with only the submitter fields returns 201 and the row is visible via query_entries",
  ],
};
