#!/usr/bin/env python3
"""
Decrypt a file encrypted by the dump-database edge function.

Wire format (binary):
  [16-byte PBKDF2 salt][12-byte AES-GCM IV][ciphertext + 16-byte GCM tag]

Key derivation: PBKDF2-SHA256, 100,000 iterations, 32-byte output.

Usage:
  python3 decrypt.py <encrypted_file> <passphrase>

Outputs decrypted plaintext to stdout.
"""
import sys


def decrypt(data: bytes, passphrase: str) -> str:
    try:
        from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        print("Missing dependency. Run: pip3 install cryptography --break-system-packages",
              file=sys.stderr)
        sys.exit(1)

    if len(data) < 16 + 12 + 16:
        raise ValueError("File too short — does not look like an encrypted backup file")

    salt       = data[:16]
    iv         = data[16:28]
    ciphertext = data[28:]

    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=100_000)
    key = kdf.derive(passphrase.encode())

    aesgcm = AESGCM(key)
    try:
        plaintext = aesgcm.decrypt(iv, ciphertext, None)
    except Exception:
        raise ValueError("Decryption failed — wrong ENCRYPTION_KEY or corrupted file")

    return plaintext.decode()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <encrypted_file> <passphrase>", file=sys.stderr)
        sys.exit(1)

    enc_file   = sys.argv[1]
    passphrase = sys.argv[2]

    with open(enc_file, "rb") as f:
        data = f.read()

    try:
        print(decrypt(data, passphrase), end="")
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
