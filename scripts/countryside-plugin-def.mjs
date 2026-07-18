/**
 * Countryside CRM — client plugin definition (case study).
 * Source doc: countryside-crm-agentx-architecture.md. Every Salesforce-ism is
 * translated to shipped primitives:
 *   lifecycle (§6)        → `leads` workflow (incl. the two Unprotected re-entries)
 *   protection/queue      → `owner` unset = unprotected; queue = query owner exists:false
 *   recycle sweep         → agent-run daily (guidance) — the L4 next-best-action loop IS the job runner
 *   no-double-book (§5.3) → computed slot_key (rep+date+slot) with unique:true
 *   honeypot (§5.6)       → beforeCreate hook (guidance; needs client endpoint) + field ships now
 *   scoring (§5.5)        → agent/hook computes `rating` (computed fields are a closed vocabulary — no arithmetic)
 *   reports (§8)          → aggregate_entries + query recipes in guidance
 * Seeded GLOBAL (operator-authored, first-party) via seed-countryside-plugin.mjs.
 */
export const COUNTRYSIDE_PLUGIN = {
  id: "countryside_crm",
  version: "1.1.0",
  name: "Countryside Land-Tour CRM",
  description:
    "Land-tour sales machine replacing a Salesforce org: ranch-scoped leads with a protection/recycle lifecycle, KIT cadence, appointment board with no-double-book, opportunities, and live report recipes. Lean first cut per the reference architecture (§10).",
  structure: {
    intent:
      "Run ranch land-tour sales end to end: web/CallRail leads land ranch-tagged, get protected by " +
      "an owning rep, move through the KIT nurture ladder to a toured appointment and an " +
      "opportunity — and stale leads AUTOMATICALLY lose protection and return to the unprotected " +
      "queue instead of rotting (the closed loop Salesforce lacked).",
    baseline: [
      {
        name: "ranches",
        displayName: "Ranches",
        fields: [
          { name: "code", label: "Code", type: "text", required: true, unique: true },
          { name: "name", label: "Name", type: "text", required: true },
          { name: "site_slug", label: "Site slug", type: "text" },
        ],
      },
      {
        // Sales reps — a first-class collection so leads.owner is a RELATION,
        // which makes the documented "leads-by-rep = groupBy owner" report
        // actually run (aggregate groupBy needs enum/relation, not text). v1.1.
        name: "reps",
        displayName: "Reps",
        fields: [
          { name: "name", label: "Name", type: "text", required: true, unique: true, searchable: true },
          { name: "email", label: "Email", type: "text" },
          { name: "active", label: "Active", type: "boolean" },
        ],
      },
      {
        name: "leads",
        displayName: "Leads",
        publicWrite: true, // ranch site forms POST straight in
        fields: [
          { name: "name", label: "Name", type: "text", required: true, searchable: true }, // ?q=/search_entries
          { name: "email", label: "Email", type: "text", indexed: true, searchable: true },
          { name: "phone", label: "Phone", type: "text", searchable: true },
          { name: "ranch_code", label: "Ranch code", type: "text", indexed: true }, // form-supplied; agent links `ranch`
          { name: "ranch", label: "Ranch", type: "relation", targetCollection: "ranches", labelField: "name", writableBy: "none" },
          { name: "source", label: "Source", type: "enum", options: ["web", "callrail", "referral", "other"] },
          // RELATION to reps — unset = UNPROTECTED; enables groupBy owner reporting.
          { name: "owner", label: "Owner (rep)", type: "relation", targetCollection: "reps", labelField: "name", writableBy: "none", indexed: true },
          { name: "previous_owner", label: "Previous owner", type: "relation", targetCollection: "reps", labelField: "name", writableBy: "none" },
          { name: "min_price", label: "Min price", type: "number" },
          { name: "max_price", label: "Max price", type: "number" },
          { name: "state_interest", label: "State interest", type: "text" },
          { name: "pre_approved", label: "Pre-approved", type: "boolean", writableBy: "none" },
          { name: "proof_of_funds", label: "Proof of funds", type: "boolean", writableBy: "none" },
          { name: "broker_referral", label: "Broker referral", type: "boolean" },
          { name: "rating", label: "Rating", type: "enum", options: ["hot", "warm", "cold", "unrated"], writableBy: "none", indexed: true },
          { name: "last_kit_at", label: "Last KIT", type: "date", writableBy: "none" },
          { name: "last_activity_at", label: "Last activity", type: "date", writableBy: "none" },
          { name: "kit_notes", label: "KIT notes", type: "richtext" },
          { name: "email_opt_out", label: "Email opt-out", type: "boolean" },
          { name: "text_opt_in", label: "Text opt-in", type: "boolean" },
          { name: "honeypot", label: "Honeypot", type: "text" }, // bots fill it; hook rejects non-empty
          { name: "status", label: "Status", type: "enum", indexed: true, writableBy: "none",
            options: ["new", "left_message", "kit", "appointment_made", "canceled_appointment", "after_sale", "hot", "no_sale", "converted", "unprotected"] },
        ],
        workflow: {
          field: "status",
          initial: "new",
          transitions: [
            { from: "new", to: "left_message", actors: ["mcp", "admin"] },
            { from: "left_message", to: "kit", actors: ["mcp", "admin"] },
            { from: "kit", to: "appointment_made", actors: ["mcp", "admin"] },
            { from: "appointment_made", to: "canceled_appointment", actors: ["mcp", "admin"] },
            { from: "canceled_appointment", to: "appointment_made", actors: ["mcp", "admin"] },
            { from: "appointment_made", to: "after_sale", actors: ["mcp", "admin"] },
            { from: "after_sale", to: "hot", actors: ["mcp", "admin"] },
            { from: "after_sale", to: "no_sale", actors: ["mcp", "admin"] },
            { from: "hot", to: "converted", actors: ["mcp", "admin"] },
            // The closed loop Salesforce lacked — §6's two re-entries:
            { from: ["new", "left_message", "kit"], to: "unprotected", actors: ["mcp", "admin"] },
            { from: "unprotected", to: "new", actors: ["mcp", "admin"] }, // reclaim
          ],
        },
      },
      {
        name: "activities",
        displayName: "Activities",
        fields: [
          { name: "lead", label: "Lead", type: "relation", targetCollection: "leads", labelField: "name", required: true },
          { name: "type", label: "Type", type: "enum", required: true, indexed: true,
            options: ["kit", "left_message", "email_sent", "appointment", "note"] },
          { name: "notes", label: "Notes", type: "richtext" },
          { name: "logged_by", label: "Logged by", type: "text" },
        ],
      },
      {
        name: "appointments",
        displayName: "Appointments",
        fields: [
          { name: "lead", label: "Lead", type: "relation", targetCollection: "leads", labelField: "name", required: true },
          { name: "rep", label: "Rep", type: "text", required: true },
          { name: "tour_date", label: "Tour date", type: "date", required: true },
          { name: "slot", label: "Slot", type: "enum", required: true,
            options: ["slot_1pm", "slot_3pm", "offboard_1pm", "offboard_3pm"] },
          // §5.3 no-double-book: one booking per rep+date+slot, DB-enforced.
          { name: "slot_key", label: "Slot key", type: "text", unique: true,
            computed: { fn: "template", template: "{{rep}}|{{tour_date}}|{{slot}}" } },
          { name: "status", label: "Status", type: "enum", options: ["made", "confirmed", "canceled"], indexed: true },
          { name: "needs_hotel", label: "Needs hotel", type: "boolean" }, // §5.4 Away Team
          { name: "away_team_notes", label: "Away Team notes", type: "richtext" },
        ],
      },
      {
        name: "opportunities",
        displayName: "Opportunities",
        fields: [
          { name: "lead", label: "Lead", type: "relation", targetCollection: "leads", labelField: "name" },
          { name: "name", label: "Name", type: "text", required: true }, // [RANCH]-[seq]-[buyers]
          { name: "stage", label: "Stage", type: "enum", indexed: true,
            options: ["qualification", "negotiation", "pending_sale", "closed_won", "closed_lost"] },
          { name: "close_date", label: "Close date", type: "date" },
          { name: "amount", label: "Amount", type: "number", indexed: true },
          { name: "owner", label: "Owner", type: "text" },
        ],
      },
    ],
    reconcile:
      "Fresh client project: apply the baseline IN ORDER (reps + ranches exist before leads relates " +
      "to them). Seed `ranches` with their five (SPR/SOR/HCR/CCR/GOR — confirm CCR/GOR names, doc " +
      "§11) and `reps` with the active sales reps (owner/previous_owner are RELATIONS to reps — " +
      "assign by rep id). If a collection already exists, EXTEND it. Point each ranch site's form " +
      "at POST /v1/leads (publicWrite) sending name/email/phone/ranch_code/source/honeypot; CallRail " +
      "via the inbound webhook or a form relay. Keep internal fields (owner, status, rating, KIT " +
      "dates) writableBy:'none' — web can never set them.",
  },
  tools: [],
  guidance:
    "You are the queue-worker for a land-tour CRM (next-best-action loop, doc §7). CONVENTIONS: " +
    "PROTECTION = leads.owner set (a rep RELATION); UNPROTECTED QUEUE = query_entries leads where " +
    "[{field:'owner',op:'exists',value:false}] (optionally + ranch_code) — this replaces the 3.1k " +
    "dead pile. ASSIGN = set owner (a reps id) + status new→left_message as you work. RECYCLE SWEEP (run " +
    "daily, YOU are the job): query leads where last_kit_at lt <30 days ago> (or " +
    "last_activity_at stale) and status in [left_message,kit] → for each: set previous_owner = " +
    "owner (copy the rep id), clear owner (null), transition status→unprotected. SEARCH leads by " +
    "name/email/phone via search_entries. KIT CADENCE: logging a KIT = create " +
    "an activities row {type:'kit'} + set leads.last_kit_at/last_activity_at = now + status→kit. " +
    "APPOINTMENTS: create appointments {rep, tour_date, slot} — a duplicate rep+date+slot is " +
    "REJECTED by the unique slot_key (that's the no-double-book guarantee; catch the conflict and " +
    "offer the next slot). COMPLIANCE: before ANY email touch, check email_opt_out (and text_opt_in " +
    "for SMS) — never contact an opted-out lead. HONEYPOT: reject any submission with a non-empty " +
    "honeypot field (add a beforeCreate hook endpoint for hard rejection; until then, sweep and " +
    "delete). SCORING: compute rating from pre_approved + proof_of_funds + budget fit vs ranch " +
    "parcels + broker_referral; store via update_entry (rating is writableBy:'none' so only " +
    "you/admin set it). REPORTS (aggregate_entries): leads-by-rep = groupBy owner; unprotected " +
    "backlog depth = count where owner exists:false; board-by-slot = appointments groupBy slot; " +
    "pipeline = opportunities groupBy stage + sum amount; KIT-overdue = leads where last_kit_at lt " +
    "<cutoff>. leads-by-rep = aggregate_entries groupBy owner (works now — owner is a relation). " +
      "CONVERSION: hot→converted + create the opportunity ([RANCH]-[seq]-[buyers] naming).",
  acceptance: [
    "all five baseline collections exist with the leads workflow enforcing initial status 'new' on every create path",
    "a lead can travel new→left_message→kit→appointment_made and kit→unprotected→new (the recycle re-entry)",
    "web POST /v1/leads succeeds with submitter fields but CANNOT set owner/status/rating (rejected 403)",
    "double-booking the same rep+tour_date+slot is rejected by the unique slot_key",
    "the unprotected-queue query (owner exists:false) returns exactly the ownerless leads",
    "an opted-out lead (email_opt_out) is excluded from any email-touch flow the agent runs",
  ],
};
