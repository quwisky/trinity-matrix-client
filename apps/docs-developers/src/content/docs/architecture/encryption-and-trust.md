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

Each new store is encrypted at rest with its own random 32-byte store key, passed as `initRustCrypto({ storageKey })`. The key is created when an account binds a new device-scoped store, kept in secure storage under `matrix.cryptoStoreKey:<cryptoPrefix>`, and deleted with the store: on sign-out, hard logout, the orphan sweep and installation reset. The account record carries a non-secret `cryptoStoreKeyed` flag. Electron, Android and iOS keep the key in the OS keychain or keystore. The web has none, so there the key is wrapped with a non-extractable AES-GCM key held in IndexedDB. That keeps the raw key out of script-readable storage, and deleting the wrapping key makes the store unreadable. It does not help against someone who can read the whole browser profile from disk, and script running in the app's origin can still ask WebCrypto to unwrap the key.

A keyed store is never opened without its key, and secure storage reads tell three cases apart: present, absent, and unavailable. Unavailable means the OS keychain cannot be reached right now, for example a keyring that is not unlocked yet, a denied keychain, or a desktop that fell back to web storage for the session. Only an absent key is lost; this happens, for example, after a restore onto a new phone or a wiped keychain. A lost key fails the start as `crypto-store-key-lost` and asks the user to sign in again. That re-authentication signs in as a new device, which gets a new store and key while the old store is reclaimed; once the new session is saved and started, the replaced device is signed out on the server, best-effort, with its old token. That sign-out is skipped when the new session's first start fails. An unavailable key fails as `secure-storage-unavailable`. Startup offers a retry once the keychain is unlocked, and also, behind a confirmation, removing the account, for a keychain that will not come back. It never replaces or deletes the store on its own.

A store created before store keys existed stays unencrypted. The crypto WASM refuses to open such a store with a key and cannot encrypt it in place, so a key is never added to an existing store. Security settings asks the user to sign out and back in on that device, which creates a new, encrypted store.

## Secrets stay behind storage adapters {#secret-storage}

The host selects the strongest available credential backend. Web storage is origin-local but script-readable; Electron accepts only a usable OS encryption backend; Capacitor uses its native secure-storage adapter without cloud synchronization, and on iOS with the this-device-only keychain class, so a backup restored onto another device does not bring the secrets along. An item written before that class was set keeps its old class until it is written again, for example at the next token refresh or sign-in. Android excludes the app's data from cloud backup and device-to-device transfer. If a native backend is unavailable, the capability reports that state rather than pretending plaintext storage is secure.

Diagnostics contain stable codes and recovery information only. Never include access tokens, recovery keys, private message content, preference values, raw server bodies, account identifiers, or unfiltered exception text.

## Trust is a capability {#trust-capability}

The Trust data-access library owns encryption health, device lists, cross-signing repair, recovery reset, and verification commands. Feature pages present those states and actions. They do not keep a second trust model or call SDK crypto methods directly.

Verification and recovery actions are finite Observables, while trust health is projected state. Preserve cancellation and account boundaries when a dialog or routed page closes.

## Photos leave without identifying metadata {#media-metadata}

Encryption hides an attachment from the homeserver, not from the people in the room. Before Media data access uploads an image (a message attachment, a profile photo or a room photo), it removes the image's identifying metadata without re-encoding it: Exif with its GPS location, camera make and model, capture time and serial numbers; XMP; IPTC; comments and text chunks; and anything appended after a JPEG's first image, such as Motion Photo videos and MPF secondary images. This covers JPEG, PNG, WebP and HEIF/AVIF. A rotated or mirrored photo keeps an Exif block holding only its orientation, so it still displays the right way up. In encrypted rooms stripping runs on the plaintext, before encryption.

The pure byte-level parsers live in `libs/data-access/media/src/lib/image-metadata`. Stripping never blocks a send: a file that cannot be parsed with certainty, and every other format (GIF, TIFF, SVG, videos, documents), is uploaded unchanged. Videos therefore still carry their recording metadata, including any location the camera wrote.

## Logout and reset are ordered cleanup {#cleanup-order}

Sign-out targets an explicit account. Soft logout preserves recovery-critical local stores for reauthentication; hard logout requests their cleanup. Installation reset gathers the identifiers needed for cleanup before deleting registries and preferences, then clears clients, SDK stores, host secrets, caches, and service workers through bounded operations.

Cleanup can be partial or uncertain when another tab or process holds a database. Surface that typed outcome; do not report success merely because observation reached its timeout.

Read [Matrix integration](../matrix-integration/) for SDK ownership and [host capabilities](../host-capabilities/) for secure-store negotiation.
