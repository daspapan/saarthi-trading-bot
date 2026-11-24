// PIN hashing with scrypt (built into Node, no extra dependency).
// Stored format: scrypt$<salt hex>$<hash hex>. The plain PIN is never stored.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 32;

export function hashPin(pin: string): string {
  if (!/^\d{4,12}$/.test(pin)) throw new Error("PIN must be 4 to 12 digits.");
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPin(pin: string, stored: string | null): boolean {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(pin, Buffer.from(saltHex, "hex"), expected.length);
  // Constant-time compare so response timing reveals nothing about the PIN.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
