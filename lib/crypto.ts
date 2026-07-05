import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for connector secrets at rest. Master key from
 * CONNECTOR_MASTER_KEY (32 bytes, base64). Stored form: iv.tag.ciphertext,
 * each base64url. Secrets are decrypted only server-side at the moment of use
 * and NEVER surface through MCP tools or the browser.
 */

function masterKey(): Buffer {
  const raw = process.env.CONNECTOR_MASTER_KEY;
  if (!raw) throw new Error("CONNECTOR_MASTER_KEY is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("CONNECTOR_MASTER_KEY must be 32 bytes (base64)");
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString("base64url")).join(".");
}

export function decryptSecret(stored: string): string {
  const [iv, tag, enc] = stored.split(".").map((s) => Buffer.from(s, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
