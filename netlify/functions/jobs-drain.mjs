// Netlify scheduled function: the ONLY host-specific piece of the job runner.
// Every minute it POSTs the host-agnostic drain endpoint with the CRON_SECRET
// bearer. On Render this file is replaced by a render.yaml cron hitting the same
// POST /api/jobs/drain — the endpoint (with its E_UNCONFIGURED fail-closed
// contract) is the portable interface.
export const config = { schedule: "* * * * *" };

export default async () => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return new Response("CRON_SECRET not set — drain skipped", { status: 503 });
  }
  const base = process.env.URL ?? process.env.DEPLOY_PRIME_URL;
  if (!base) return new Response("site URL unavailable", { status: 500 });

  const res = await fetch(`${base}/api/jobs/drain`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
  return new Response(await res.text(), { status: res.status });
};
