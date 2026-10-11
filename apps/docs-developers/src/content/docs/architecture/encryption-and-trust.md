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

## Setup never replaces an existing identity {#identity-preservation}

Trust reads one status per Account with `readTrustSnapshot`: `ready`; `needs-recovery` when secret storage exists but this device has not unlocked it; `needs-verification` when the Account has a cross-signing identity that another device published, no secret storage, and this device neither holds the private keys nor is verified; and `needs-setup` otherwise: no identity, this device holds it and only recovery is missing, or this device is verified but the private keys stay on the device that published the identity. That last case is `TrustService.recoverySetupElsewhere`: the banner and Security settings point the user to the device where encryption was first set up instead of offering setup. First-device setup is offered only for `needs-setup` without an identity held elsewhere. Private keys on this device count as the identity only when the published identity verifies against them (`isCrossSigningReady`): a reset cancelled before its upload leaves a full set of keys nobody published, and setting up recovery from those would store keys that can never verify a device.

`TrustService.setUp` also refuses an Account whose identity lives elsewhere. It first re-reads the Account's published identity from the homeserver (`userHasCrossSigningKeys(undefined, true)`, which refreshes the device's copy and drops private keys that don't match it), then checks the keys this device holds against that identity, all before bootstrapping, because `bootstrapCrossSigning` with no private keys available creates new keys and replaces the identity, which cuts the user's other devices out of every MSC4153 strict sender's recipients. For the Account's own user that call answers from the device's refreshed copy, so an identity this device created but never uploaded (a first setup whose upload was cancelled at the password prompt or failed) still reads as present. Setup therefore also asks the homeserver for the published master key (`/keys/query`, `readPublishedMasterKey`). When this device holds an identity's private keys but the server has no master key, setup bootstraps with `setupNewCrossSigning: true` and uploads new keys: there is nothing on the server to replace, and without it `bootstrapCrossSigning` would keep the unpublished keys and secret storage would store them. If the device holds no keys there, its two reads disagree, and setup refuses rather than create keys over an identity the server may still have. Setup also refuses when the server's master key isn't the one this device holds. Both reads fail closed, and the refusal links to Security settings, where verifying and resetting live. Resetting the identity remains a separate, explicitly confirmed action. It lives in Security settings, never in the room banner, which cannot be dismissed; for an Account without secret storage the reset page asks for no recovery key.

## Photos and videos leave without identifying metadata {#media-metadata}

Encryption hides an attachment from the homeserver, not from the people in the room. Before an image is uploaded, its identifying metadata is removed without re-encoding it. Media data access does this for message attachments and profile photos, and Room administration uses Media's `withoutImageMetadata` helper for room photos. It removes Exif with its GPS location, camera make and model, capture time and serial numbers; XMP; IPTC; comments and text chunks; and anything appended after a JPEG's first image, such as Motion Photo videos and MPF secondary images. This covers JPEG, PNG, WebP and HEIF/AVIF. GIFs lose their comment and application extensions (XMP included) and keep loop control, colour profile and every frame. In TIFFs the identifying values are zeroed in place, so no offset moves: camera, software, author, document and page name, time, XMP, IPTC, Photoshop and Windows XP tags; the Exif IFD's serial numbers, unique ID, capture times and offsets, image history and MakerNote; and the whole GPS IFD. A TIFF-based camera raw (a DNGVersion tag, or a raw file name or MIME type such as `.nef` or `image/x-adobe-dng`) loses only its GPS IFD, because raw converters decode with its camera tags and MakerNote. Its XMP, which can repeat the location, is kept too. SVGs lose `<metadata>`, comments and editor namespaces (Inkscape, Sodipodi, Adobe, Sketch, RDF, Dublin Core) but keep `<title>` and `<desc>`; they are parsed with the platform XML parser and serialized again, and they are not sanitized: scripts stay as they are. A rotated or mirrored photo keeps an Exif block holding only its orientation, so it still displays the right way up. In encrypted rooms stripping runs on the plaintext, before encryption.

Message attachments that are MP4, MOV or 3GP movies, whether sent as videos or as files, lose their capture location and device identity the same way. Only the `moov` box is edited, in place: location atoms (`©xyz`, `loci`), device and software atoms (`©mak`, `©mod`, `©swr`) and XMP become `free` boxes of the same size, and the values of Apple's `keys`/`ilst` items for location, make, model, lens model, software, serial numbers and device ids are zeroed. No box moves, so chunk offsets stay valid and nothing is re-encoded. The capture date, encoder name and frame rate are kept. A movie is never loaded whole: unencrypted uploads read only the top-level box headers and `moov` (up to 64 MiB) and send slices of the original file around the patched `moov`; encrypted uploads, which read the whole plaintext anyway, are patched in that buffer. A thumbnail supplied by the native camera with a capture goes through the same image stripping before it is uploaded; a thumbnail rendered on a canvas carries no metadata.

Video stripping has known limits. These are uploaded as they are:

- location written into the samples by timed metadata tracks, such as iPhone `mebx` tracks, GoPro GPMF or DJI telemetry;
- boxes outside `moov`, such as a top-level XMP `uuid` box, and vendor data after `mdat`, such as Samsung's trailer;
- iTunes freeform `----` items in `ilst`;
- vendor `udta` atoms that are not removed: Canon's `CMT1`–`CMT4` (Exif blocks that can hold GPS), and GoPro's `GPMF` (telemetry) and `CAME` (camera serial number);
- compressed movies whose metadata is inside a `cmov` box, which are left unchanged as a whole;
- fragmented MP4 (`moof`, or `mvex` in `moov`), which is left unchanged as a whole.

Apple `keys` items that are stripped stay listed, with zeroed values.

The pure byte-level parsers live in `libs/data-access/media/src/lib/image-metadata`. An Exif block that cannot be read inside an otherwise sound file is dropped whole, orientation included. Stripping never blocks a send: a file whose container cannot be parsed with certainty, a BigTIFF, an SVG that is not UTF-8, is over 16 MiB or has an element with more than 1,024 attributes, a fragmented movie, a movie with a `moov` over 64 MiB, and every other format (WebM, documents), is uploaded unchanged, with whatever metadata it carries. A raw file is only recognised by its DNGVersion tag, name or MIME type, so a raw sent as a nameless blob with an empty type and no DNGVersion gets the full TIFF blanking.

Settings → Privacy → **Keep photo and video metadata** (off by default, stored per device under the older key `trinity.privacy.keep-photo-metadata`) lets a person send message attachments with their metadata. Conversations reads the choice when a send starts and passes it to Media Pipeline as the transfer's `imageMetadata` policy; with `'keep'` a photo or video is uploaded byte for byte, in plaintext and encrypted rooms alike, never partially stripped. A thumbnail supplied by the native camera is still stripped, since it is a derived preview rather than the person's file. Profile and room photos ignore the setting and are always stripped, because they are public and persistent.

## Logout and reset are ordered cleanup {#cleanup-order}

Sign-out targets an explicit account. Soft logout preserves recovery-critical local stores for reauthentication; hard logout requests their cleanup. Installation reset gathers the identifiers needed for cleanup before deleting registries and preferences, then clears clients, SDK stores, host secrets, caches, and service workers through bounded operations.

Cleanup can be partial or uncertain when another tab or process holds a database. Surface that typed outcome; do not report success merely because observation reached its timeout.

Read [Matrix integration](../matrix-integration/) for SDK ownership and [host capabilities](../host-capabilities/) for secure-store negotiation.
