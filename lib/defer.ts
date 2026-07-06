import { after } from "next/server";

/**
 * Run side-work AFTER the response is sent, surviving serverless freeze.
 * A bare `void promise` is fine locally but on serverless the runtime may
 * suspend the instance the moment the response streams out — Next's after()
 * keeps the function alive until the task settles. Outside a request scope
 * (tests, scripts) after() throws, so fall back to fire-and-forget, which is
 * exact there anyway.
 */
export function defer(task: () => Promise<unknown>): void {
  try {
    after(task);
  } catch {
    void task().catch(() => {});
  }
}
