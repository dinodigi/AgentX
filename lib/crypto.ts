import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for connector secrets at rest. Secrets are decrypted only
 * server-side at the moment of use and NEVER surface through MCP tools or the
 * browser.
 *
 * KEYED ENVELOPES (A2): after the data-plane split, the master key sits on
 * every content read/write of every connector-backed project — so it must be
 * rotatable without bricking stored ciphertexts. Two stored forms:
 *
 *   v1 (legacy):  iv.tag.ciphertext            — encrypted with CONNECTOR_MASTER_KEY
 *   v2:           v2.<kid>.iv.tag.ciphertext   — encrypted with keyring[kid]
 *
 * The keyring comes from CONNECTOR_MASTER_KEYS (JSON: {"k1":"<base64 32B>"}),
 * plus the reserved kid "k0" for CONNECTOR_MASTER_KEY when it is set. New
 * ciphertexts always use the ACTIVE key (CONNECTOR_MASTER_KEY_ACTIVE, or the
 * only key when unambiguous). Decryption is fail-closed: an unknown kid or a
 * missing legacy key throws — it must never silently degrade.
 *
 * ROTATION RUNBOOK: (1) add the new key to CONNECTOR_MASTER_KEYS and point
 * CONNECTOR_MASTER_KEY_ACTIVE at it; (2) keep the old key in the ring (or
 * CONNECTOR_MASTER_KEY for v1 blobs) so existing ciphertexts still decrypt;
 * (3) re-encrypt at leisure (needsReencrypt identifies stale blobs);
 * (4) only then drop the old key from the env.
 */

/** Reserved kid for the legacy single CONNECTOR_MASTER_KEY. */
const LEGACY_KID = "k0";
const KID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function parseKey(raw: string, label: string): Buffer {
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`${label} must be 32 bytes (base64)`);
  return key;
}

/** kid → key. CONNECTOR_MASTER_KEYS entries + CONNECTOR_MASTER_KEY as "k0". */
function keyring(): Map<string, Buffer> {
  const ring = new Map<string, Buffer>();
  const legacy = process.env.CONNECTOR_MASTER_KEY;
  if (legacy) ring.set(LEGACY_KID, parseKey(legacy, "CONNECTOR_MASTER_KEY"));
  const json = process.env.CONNECTOR_MASTER_KEYS;
  if (json) {
    let entries: Record<string, string>;
    try {
      entries = JSON.parse(json) as Record<string, string>;
    } catch {
      throw new Error("CONNECTOR_MASTER_KEYS must be a JSON object of {kid: base64Key}");
    }
    for (const [kid, raw] of Object.entries(entries)) {
      if (!KID_RE.test(kid)) throw new Error(`CONNECTOR_MASTER_KEYS: invalid kid "${kid}"`);
      ring.set(kid, parseKey(raw, `CONNECTOR_MASTER_KEYS["${kid}"]`));
    }
  }
  if (ring.size === 0) throw new Error("CONNECTOR_MASTER_KEY (or CONNECTOR_MASTER_KEYS) is not set");
  return ring;
}

/** The kid new ciphertexts are written with. Fail-closed on ambiguity. */
function activeKid(ring: Map<string, Buffer>): string {
  const configured = process.env.CONNECTOR_MASTER_KEY_ACTIVE;
  if (configured) {
    if (!ring.has(configured)) {
      throw new Error(`CONNECTOR_MASTER_KEY_ACTIVE="${configured}" names no key in the ring`);
    }
    return configured;
  }
  if (ring.size === 1) return ring.keys().next().value!;
  throw new Error(
    "multiple master keys configured — set CONNECTOR_MASTER_KEY_ACTIVE to the kid new secrets should use",
  );
}

export function encryptSecret(plaintext: string): string {
  const ring = keyring();
  const kid = activeKid(ring);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ring.get(kid)!, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v2", kid, ...[iv, tag, enc].map((b) => b.toString("base64url"))].join(".");
}

export function decryptSecret(stored: string): string {
  const parts = stored.split(".");
  let key: Buffer;
  let payload: Buffer[];
  if (parts.length === 5 && parts[0] === "v2") {
    const kid = parts[1];
    const found = keyring().get(kid);
    if (!found) {
      throw new Error(
        `no master key for kid "${kid}" — it was rotated out of the ring while ciphertexts still use it (fail-closed)`,
      );
    }
    key = found;
    payload = parts.slice(2).map((s) => Buffer.from(s, "base64url"));
  } else if (parts.length === 3) {
    // Legacy v1: always CONNECTOR_MASTER_KEY. Required while any v1 blob exists.
    const legacy = keyring().get(LEGACY_KID);
    if (!legacy) {
      throw new Error("a legacy (v1) ciphertext needs CONNECTOR_MASTER_KEY, which is not set (fail-closed)");
    }
    key = legacy;
    payload = parts.map((s) => Buffer.from(s, "base64url"));
  } else {
    throw new Error("unrecognized ciphertext format");
  }
  const [iv, tag, enc] = payload;
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

/**
 * True when `stored` was NOT written with the active key — a rotation sweep
 * re-encrypts exactly these (decryptSecret → encryptSecret). v1 blobs count as
 * stale unless the legacy key IS the active one.
 */
export function needsReencrypt(stored: string): boolean {
  const ring = keyring();
  const active = activeKid(ring);
  const parts = stored.split(".");
  const kid = parts.length === 5 && parts[0] === "v2" ? parts[1] : LEGACY_KID;
  return kid !== active;
}
