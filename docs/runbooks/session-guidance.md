# End-user session guidance (JWT-only verification)

The delivery API verifies end-user JWTs purely cryptographically against the
project's own issuer (Clerk connector): signature via the issuer's public
JWKS, `iss`, `exp` (±30s clock tolerance), and optionally `aud`. There are
**no per-request calls to the issuer** — which is what makes it fast and
BYO-friendly, and also what creates the one caveat this doc exists for.

## The caveat: no server-side logout

A verified token is valid until it EXPIRES. Banning a user in Clerk, signing
them out everywhere, or deleting their account does NOT invalidate tokens
already minted — the delivery API has no revocation list to check.

The exposure window = the token's TTL. Clerk session tokens default to 60
seconds and the SDK refreshes them silently, so with standard Clerk usage the
window is about a minute — fine for almost everything.

## Guidance

- **Sites should send fresh tokens.** Use Clerk's `getToken()` per request
  (the SDK caches/refreshes correctly); never store a token and replay it.
- **Keep TTLs short for sensitive collections.** If you customize Clerk
  session token lifetime, remember: that number is your revocation latency.
- **Set `audience` on the connector** when the same Clerk instance serves
  more than one app, so a token minted for another app can't be replayed here.
- **List staging + prod issuers deliberately.** `additionalIssuers` exists so
  one project can accept both during a migration — remove the stale one after.
- **Ownership survives bans.** `ownerField` stores the Clerk user id; a banned
  user's rows stay intact and become invisible to everyone but admins.
- If a project ever needs sub-minute revocation (financial actions, moderation
  tooling), that's the evidence-gate for introspection/short-poll checks —
  file it in the friction log rather than working around it in the site.
