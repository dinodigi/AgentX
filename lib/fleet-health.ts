/**
 * Which projects need attention, and why — derived once, so the fleet banner
 * can NAME them.
 *
 * WHY THIS IS A FUNCTION AND NOT A `.some()`. It was a `.some()`. The banner
 * knew a project had a connector in error and reported "attention needed",
 * discarding which project and which connector — so the only way to find the
 * broken one was to open every project in turn. An indicator that tells you
 * something is wrong without telling you where is barely better than no
 * indicator; it just relocates the work.
 *
 * Pure and dependency-free so the suite can assert it directly. The previous
 * version lived inline in a server component, which is precisely why nothing
 * caught it going useless.
 */

export interface FleetConnector {
  type: string;
  status: string;
}

export interface FleetHealthInput {
  id: string;
  name: string;
  connectors: FleetConnector[];
}

export interface AilingProject<T extends FleetHealthInput> {
  project: T;
  /** The connector types in error — the "why", as far as we store it. */
  failing: string[];
}

/**
 * Projects with at least one connector in error, each with the failing types.
 *
 * Order is preserved from the input so the banner is stable between renders,
 * and `failing` is sorted so two projects broken the same way read the same.
 */
export function ailingProjects<T extends FleetHealthInput>(projects: T[]): AilingProject<T>[] {
  const out: AilingProject<T>[] = [];
  for (const project of projects) {
    const failing = project.connectors
      .filter((c) => c.status === "error")
      .map((c) => c.type)
      .sort();
    // A connector can appear twice for one type across environments; naming it
    // twice in the banner reads as a bug rather than as detail.
    const unique = [...new Set(failing)];
    if (unique.length > 0) out.push({ project, failing: unique });
  }
  return out;
}
