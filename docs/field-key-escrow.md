# Production field-encryption key — escrow and custody

Covers `FIELD_ENCRYPTION_KEY` (Production), provisioned 2026-08-22 as
`prod-v1:<64 hex>`. No key material appears in this document, and none may be
added to it.

## Current state

| | |
|---|---|
| Live copy | Vercel Production env `VoNJDTWIn6Lf3yuz`, type `sensitive` — **write-only**, unreadable by API, CLI and dashboard |
| Escrow copy | `~/.bookpitch/field-encryption-key-production.age`, mode `0400`, 272 bytes |
| Escrow recipient | `ops/backup-age-recipient.txt` (committed, encrypt-only) |
| Decryption identity | `~/.bookpitch/backup-age-key.txt` (mode `0400`) **and** GitHub secret `BACKUP_AGE_PRIVATE_KEY` |
| Recovery proven | Yes — decrypted and compared byte-for-byte at provisioning time |

Because the Vercel copy is write-only, **the escrow blob is the only readable
copy that exists**. Losing it means the key is gone, and with it any field
ciphertext written after provisioning. Production holds zero ciphertext today,
which is the only reason the current arrangement is not already urgent.

## Problem 1 — the escrow shares an identity with database backups

The field key is encrypted to the *backup* age recipient. That collapses a real
defence-in-depth boundary:

- **Before:** the backup age key decrypted an encrypted database dump. The
  clinical fields inside it stayed encrypted, because `FIELD_ENCRYPTION_KEY`
  lived only in Vercel.
- **Now:** one age private key decrypts both the dump *and* the key to its
  clinical fields.

Anyone holding `BACKUP_AGE_PRIVATE_KEY` — including the GitHub Actions restore
drill — is one step from patient plaintext.

### Proposed: a dedicated field-key escrow identity

Not executed. Needs approval and a verified destination.

1. Generate a **separate** X25519 identity, e.g. `bookpitch-secrets-recipient`.
   Never inside the repository.
2. Commit only its public half, as `ops/secrets-age-recipient.txt`, alongside the
   existing backup recipient. Public halves are safe to commit.
3. Re-encrypt the field key to the new recipient; write the new blob **before**
   removing the old one.
4. Prove recovery with the new identity by decrypt-and-compare, non-printing.
5. Only then delete `~/.bookpitch/field-encryption-key-production.age`.
6. Do **not** put the new private key in GitHub Actions. Nothing in CI needs to
   decrypt the field key — that is the entire point of separating it.

The two identities then have genuinely different blast radii: backups stay
restorable by automation, while field plaintext requires an identity that only
the owner holds.

## Problem 2 — the escrow exists on one machine

`~/.bookpitch/` on a single laptop is the only readable copy. Disk failure,
theft or a clean OS install loses it.

### Proposed: off-device copy procedure

Not executed — it needs a destination you designate.

The blob is *already* encrypted to an age recipient, so the copy itself needs no
further protection; it needs **durability and separation from the private key**.

```bash
# The blob is ciphertext. Copying it is safe; it is useless without the identity.
cp ~/.bookpitch/field-encryption-key-production.age <destination>

# Verify the copy decrypts, without printing anything:
age -d -i ~/.bookpitch/backup-age-key.txt <destination>/field-encryption-key-production.age \
  | cmp -s - <(age -d -i ~/.bookpitch/backup-age-key.txt ~/.bookpitch/field-encryption-key-production.age) \
  && echo "copy verified" || echo "COPY MISMATCH"
```

Rules for the destination:

- It must **not** also hold the age private identity. Storing both together
  reduces the pair to a single plaintext copy.
- It must survive the loss of this machine — a different physical device, or a
  storage account whose credentials are not on this machine.
- No plaintext copy anywhere, ever. Never in the repository, a note, a chat, a
  screenshot, a log, a CI variable or a memory file.

Candidates worth considering, none currently installed: a password manager with a
CLI (`op`, `bw`), a hardware-backed store, or an offline encrypted volume. The
survey during provisioning found none configured on this machine — which is why
the backup age identity was reused rather than something new invented.

## Rules that do not bend

- Never print, echo, log or display the key, a substring, a hash or a
  fingerprint. Boolean comparisons only.
- Never pass it as a command-line argument. Request bodies and stdin only.
- Never re-provision "to try something". It is escrowed; an unexplained rewrite
  is an unaudited rotation.
- If ciphertext ever becomes non-zero, replacing the key stops being safe and
  becomes a data-bearing rotation requiring `scripts/rotate-encryption-key.ts`
  and `FIELD_ENCRYPTION_OLD_KEYS`. Re-check
  `SELECT count(*)` across the six ciphertext columns before any key work.
