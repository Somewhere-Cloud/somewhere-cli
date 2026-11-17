Run `npm run check:credentials` before merging. It scans tracked and unignored new files, including scripts, tests, documentation and committed environment files. Diagnostics contain only path, line and kind.

Provider patterns reuse the platform source scanner (the generated module records its source). Review every exception in `credential-allowlist.json`: only synthetic test material, public examples and non-secret syntax belong there. Entries are bound to path, kind and the first eight SHA-256 hex digits; changing a literal or moving it requires review again. Never allow a real or live fixture credential. Never print a match to investigate it.

`node scripts/test-check-credentials.mjs` plants random fake material, asserts rejection and value-free diagnostics, then removes it. Password and key values used by live fixtures belong in the release fixture store.
