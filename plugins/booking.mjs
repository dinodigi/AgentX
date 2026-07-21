/**
 * Booking — base plugin (wave 1). Extracted from the countryside CRM's
 * appointments: the no-double-book computed slot key, generalized to any
 * resource (rep, room, table, chair, machine). One capability: `booking`.
 * Pairs with AUTO-1: stale holds expire via a declarative scheduled mutation.
 */
export const BOOKING_PLUGIN = {
  id: "booking",
  version: "1.0.0",
  provides: "booking",
  name: "Booking — slots without double-booking",
  description:
    "Bookable resources + slot reservations with a database-enforced no-double-book guarantee " +
    "(computed slot key, unique). Hold → confirm lifecycle with admin-gated completion, and a " +
    "define-once scheduled sweep that expires stale holds. Extracted from the Countryside CRM's " +
    "proven appointment engine.",
  structure: {
    intent:
      "Let a project take reservations against any resource with hard uniqueness per " +
      "resource+date+slot, a hold/confirm lifecycle, and self-hosting expiry of abandoned holds.",
    baseline: [
      {
        name: "booking_resources",
        displayName: "Bookable resources",
        fields: [
          { name: "name", label: "Name", type: "text", required: true, unique: true, searchable: true, max: 120 },
          { name: "active", label: "Active", type: "boolean" },
          { name: "notes", label: "Notes", type: "text", max: 1000 },
        ],
      },
      {
        name: "bookings",
        displayName: "Bookings",
        fields: [
          { name: "resource", label: "Resource", type: "relation", targetCollection: "booking_resources", labelField: "name", required: true, indexed: true },
          { name: "booking_date", label: "Date", type: "date", required: true },
          { name: "slot", label: "Slot", type: "text", required: true, max: 40 },
          // The no-double-book guarantee: one booking per resource+date+slot.
          { name: "slot_key", label: "Slot key", type: "text", unique: true,
            computed: { fn: "template", template: "{{resource}}|{{booking_date}}|{{slot}}" } },
          { name: "booked_for", label: "Booked for", type: "text", max: 200, searchable: true },
          { name: "contact", label: "Contact", type: "text", max: 254 },
          { name: "notes", label: "Notes", type: "text", max: 2000 },
          { name: "held_at", label: "Held at", type: "date", writableBy: "none" },
          { name: "status", label: "Status", type: "enum", indexed: true, writableBy: "none",
            options: ["held", "confirmed", "canceled", "completed"] },
        ],
        workflow: {
          field: "status",
          initial: "held",
          transitions: [
            { from: "held", to: "confirmed", actors: ["mcp", "admin", "delivery"] },
            { from: "held", to: "canceled", actors: ["mcp", "admin", "delivery"] },
            { from: "confirmed", to: "canceled", actors: ["mcp", "admin"] },
            { from: "confirmed", to: "completed", actors: ["mcp", "admin"] },
          ],
        },
      },
    ],
    reconcile:
      "Apply resources before bookings (the relation resolves). If an appointments-like collection " +
      "already exists, EXTEND it with the slot_key pattern instead of duplicating. Set held_at at " +
      "create (the backend stamps it via MCP; it is writableBy:'none'). For public self-serve " +
      "booking, front it with the tenant's backend or a lead_capture intake — do not publicWrite " +
      "the bookings collection itself.",
  },
  tools: [],
  guidance:
    "You are operating a booking book. RESERVE = create bookings {resource, booking_date, slot, " +
    "booked_for, held_at: now} — a duplicate resource+date+slot is REJECTED by the unique " +
    "slot_key; catch the conflict and offer the next slot. CONFIRM = transition held→confirmed. " +
    "EXPIRE STALE HOLDS (define once, the platform runs it): define_schedule {name:'expire-holds', " +
    "recurrence:{frequency:'hourly'}, action:{type:'mutate', collection:'bookings', " +
    "where:[{field:'held_at',op:'lt',value:{hoursAgo:24}},{field:'status',op:'in',value:['held']}], " +
    "transition:{to:'canceled'}}}. AVAILABILITY = query bookings for a resource+date and diff " +
    "against your slot grid (the grid is app-defined — slots are free text). REPORTS: bookings " +
    "groupBy resource; utilization = count confirmed per date range.",
  acceptance: [
    "both collections exist; bookings workflow enforces initial status 'held' on every create path",
    "double-booking the same resource+booking_date+slot is rejected by the unique slot_key",
    "held→confirmed and held→canceled work; confirmed→completed is mcp/admin only",
    "an expire-holds mutate schedule cancels stale holds and leaves fresh ones untouched",
  ],
};
