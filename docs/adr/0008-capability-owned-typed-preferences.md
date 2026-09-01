---
status: accepted
---

# Capabilities own typed preference descriptors

Each preference is declared by its product capability as a typed descriptor containing a stable
id, owner, explicit scope, default, validator, versioned migration, sensitivity, storage and
export policy, and optional editor metadata. `@trinity/runtime/preferences` is a policy-free
kernel: it validates and indexes contributed descriptors, keeps context-keyed read-only signal
state, and executes hydration and updates as cold finite RxJS Observables with typed recovery.

Installation, Account, Conversation, and server-authoritative contexts are separate discriminated
variants rather than optional identifiers on one loose scope. Storage adapters receive the whole
context and declared policy. Device Preferences refuses secrets, secure-store values, and
server-authoritative values instead of silently weakening their policy. Secret descriptors must
use `secure-store` storage and be excluded from portable exports, and diagnostics contain stable
codes only—never candidate, stored, or thrown values.

A descriptor may declare ordered, read-only legacy persistence keys. The current key is always
authoritative when present; predecessor keys are consulted only when it is missing. A valid legacy
value is migrated and written as the current versioned envelope before the signal publishes it,
while invalid legacy data defaults only that descriptor and reports value-free recovery. Every
later write targets only the current key, so this is a one-way upgrade contract and does not
promise downgrade compatibility. Synchronous adapter failures and errored storage streams are
contained behind the same stable read/write diagnostics.

Appearance is the first cross-capability composition of this contract. Design System owns four
installation-scoped descriptors (Mode, Theme, text size, and density), while Conversations owns
code size and code-line presentation. Each has its own current `trinity.appearance.*` key and uses
the former ThemeService key only as read-only migration metadata. The application Appearance model
projects the six committed values and their individual states without owning storage. An invalid or
unavailable axis therefore defaults independently, and one partial hydration outcome carries one
recoverable Appearance warning instead of six application-level warnings. Theme validation reads
the Theme Foundation catalog, so an unknown or removed Theme id follows the same isolated default
path as any other rejected value.

Resolved Appearance is a separate application projection, not storage policy. A pure resolver
combines the six committed axes with the current system Mode. Its cold effect lifetime owns the
system colour-scheme subscription and sends the result to two narrow ports: the document adapter
owns all root classes, attributes, and styles, while native chrome receives only resolved Mode.
System colour-scheme changes therefore have no observable effect under an explicit light or dark
Mode, and a failed preference write cannot change resolved or rendered Appearance because the
Preferences Store has not committed it.

Default values remain stylesheet-owned. The document adapter removes the optional Theme, text
size, density, code-size, and code-line carriers at their defaults; light Mode removes the dark
class. Concrete startup and native-host bindings remain part of the staged migration, so this
expand step does not alter the existing CSS-only first-paint splash contract.

Settings is a catalog consumer, not a policy owner. Its shared renderer selects descriptor editor
metadata for an exact context and subscribes to the descriptor command; it does not know raw keys,
defaults, migration rules, or capability policy. The Privacy journey is the first migrated slice.
Its descriptors are defined and exported by the Conversations capability in
`@trinity/data-access/timeline`. The capability contributes them to the policy-free catalog; the
application composition root separately binds the same descriptor set to the temporary
`PrivacySettingsService` compatibility facade. Existing callers continue to read signals while
migration proceeds under the incremental-facade decision. The Advanced configuration registry
continues through the facade, and its guard pins portable descriptor keys to the export ledger
until that older registry can consume the catalog directly.
