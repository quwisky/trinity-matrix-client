---
title: Security invariants
description: Preserve Trinity's checked Matrix input, diagnostics, SDK, Electron IPC, and preference boundaries.
audience: developer
contentChannel: develop
canonicalTopic: reference-security-invariants
pageType: reference
platforms: [web, desktop, android, ios]
---

The repository security baseline defines five invariants. A change touching one needs its enforcement check and behavior-specific tests.

## Required invariants {#required-invariants}

| Invariant                   | Required property                                                                          | Enforcement                                      |
| --------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Normalized Matrix input     | Capability and presentation code consume normalized events                                 | Adapter contracts and hostile-input tests        |
| Secret-safe diagnostics     | Credentials, secret material, message bodies, and precise location stay out of diagnostics | Typed failure metadata and hostile-adapter tests |
| SDK import containment      | Matrix SDK imports stay in approved adapters and pure Matrix modeling utilities            | ESLint and architecture checks                   |
| Electron IPC boundary       | IPC is versioned, sender-validated, and capability-scoped                                  | Host contract and IPC security tests             |
| Sensitive preference policy | Sensitive settings declare storage and export restrictions                                 | Preference catalog and export-schema guards      |

## Apply the invariants {#apply-invariants}

Treat Matrix events, deep links, host messages, configuration documents, and imported files as untrusted. Normalize and validate them at the owning adapter before capability or presentation code consumes them.

Use the narrowest public contract. Do not expose SDK objects, Electron channels, native plugin instances, storage keys, or secret-bearing exception payloads across layers.

Run `pnpm architecture:check` and the focused security/host/capability tests after changing one of these boundaries. A successful compile alone does not exercise hostile input or runtime sender validation.

Read [diagnostics](../diagnostics/) and [encryption and trust](../../architecture/encryption-and-trust/) for related lifecycle rules.
