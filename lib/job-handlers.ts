import type { JobHandlers } from "./jobs";

/**
 * Built-in job handlers keyed by `job.kind`. Declarative features register their
 * kind here (G2 `event_action`, G3 `schedule_fire`, …). A handler runs from
 * CURRENT config, never a queued copy, and must be idempotent (at-least-once
 * delivery). `noop` exists so the queue machinery is provable without a feature.
 */
export const HANDLERS: JobHandlers = {
  noop: async () => {},
};
