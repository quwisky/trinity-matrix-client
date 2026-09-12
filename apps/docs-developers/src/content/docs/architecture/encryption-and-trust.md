---
title: Encryption and trust
description: Preserve Trinity's account-scoped crypto stores, secret handling, verification, and cleanup boundaries.
audience: developer
contentChannel: develop
canonicalTopic: architecture-encryption-trust
pageType: explanation
platforms: [web, desktop, android, ios]
---

End-to-end encryption spans account lifecycle, SDK persistence, secret storage, recovery, and device verification. Trinity keeps those responsibilities separated so a UI flow cannot accidentally take ownership of cryptographic state.

## Device-scoped crypto storage {#crypto-storage}

Rust crypto storage belongs to a Matrix user and device. New-device login receives a device-scoped prefix of the form `trinity-crypto:${userId}:${deviceId}`; same-device reauthentication can reuse the recorded prefix. Store teardown must use the prefix captured by the Account rather than reconstructing it from current UI state.

The SDK's crypto database naming logic is centralized in `libs/util/matrix`. Do not duplicate suffixes or call broad store-clearing APIs without the corresponding account-owned prefix.

## Secrets stay behind storage adapters {#secret-storage}

The host selects the strongest available credential backend. Web storage is origin-local but script-readable; Electron accepts only a usable OS encryption backend; Capacitor uses its native secure-storage adapter without cloud synchronization. If a native backend is unavailable, the capability reports that state rather than pretending plaintext storage is secure.

Diagnostics contain stable codes and recovery information only. Never include access tokens, recovery keys, private message content, preference values, raw server bodies, account identifiers, or unfiltered exception text.

## Trust is a capability {#trust-capability}

The Trust data-access library owns encryption health, device lists, cross-signing repair, recovery reset, and verification commands. Feature pages present those states and actions. They do not keep a second trust model or call SDK crypto methods directly.

Verification and recovery actions are finite Observables, while trust health is projected state. Preserve cancellation and account boundaries when a dialog or routed page closes.

## Logout and reset are ordered cleanup {#cleanup-order}

Sign-out targets an explicit account. Soft logout preserves recovery-critical local stores for reauthentication; hard logout requests their cleanup. Installation reset gathers the identifiers needed for cleanup before deleting registries and preferences, then clears clients, SDK stores, host secrets, caches, and service workers through bounded operations.

Cleanup can be partial or uncertain when another tab or process holds a database. Surface that typed outcome; do not report success merely because observation reached its timeout.

Read [Matrix integration](../matrix-integration/) for SDK ownership and [host capabilities](../host-capabilities/) for secure-store negotiation.
