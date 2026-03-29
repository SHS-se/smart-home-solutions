#!/usr/bin/env node
/**
 * Decrypt a file encrypted by the dump-database edge function.
 *
 * Wire format (binary):
 *   [16-byte PBKDF2 salt][12-byte AES-GCM IV][ciphertext + 16-byte GCM tag]
 *
 * Key derivation: PBKDF2-SHA256, 100,000 iterations, 32-byte output.
 *
 * Usage:
 *   node decrypt.mjs <encrypted_file> <passphrase>
 *
 * Outputs decrypted plaintext to stdout.
 */
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { readFileSync } from "node:fs";

const [, , encFile, passphrase] = process.argv;
if (!encFile || !passphrase) {
  process.stderr.write(`Usage: node decrypt.mjs <encrypted_file> <passphrase>\n`);
  process.exit(1);
}

const data = readFileSync(encFile);
if (data.length < 16 + 12 + 16) {
  process.stderr.write("Error: File too short — does not look like an encrypted backup file\n");
  process.exit(1);
}

const salt       = data.subarray(0, 16);
const iv         = data.subarray(16, 28);
const ciphertext = data.subarray(28, data.length - 16);
const authTag    = data.subarray(data.length - 16);

const key = pbkdf2Sync(passphrase, salt, 100_000, 32, "sha256");

try {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  process.stdout.write(plaintext);
} catch {
  process.stderr.write("Error: Decryption failed — wrong ENCRYPTION_KEY or corrupted file\n");
  process.exit(1);
}
