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
its predecessor key only as read-only migration metadata. The application Appearance model
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

Application Runtime starts the effect immediately after successful preference hydration, before
Account restoration and Workspace routing, and owns it until runtime stop. Settings observes the
read-only resolved projection but does not own the effect. No compatibility facade remains, and
the document adapter is the only owner of the root carriers.

Default values remain stylesheet-owned. The document adapter removes the optional Theme, text
size, density, code-size, and code-line carriers at their defaults; light Mode removes the dark
class. Startup, native chrome, portable configuration, and widget consumers bind through narrow
Appearance projections without altering the existing CSS-only first-paint splash contract.

Settings is a catalog consumer, not a policy owner. Its shared renderer selects descriptor editor
metadata for an exact context and subscribes to the descriptor command; it does not know raw keys,
defaults, migration rules, or capability policy. The Appearance journey consumes its six-axis
application model and the select editor metadata carried by each descriptor. A user command keeps
the committed value rendered until its write completes; failure leaves that value in place and
offers Retry beside only the initiating control. Partial hydration produces one screen warning,
and recovery resets only failed axes through their descriptor defaults while preserving the other
five. Application Runtime hydrates the aggregate before Workspace routing and owns one cold
Appearance effect subscription for the whole application session; the routed screen owns only
user commands and failed-axis recovery.

Application composition inventories twelve current preference producers under stable installation
`hydrate-*` operations. They settle independently into declared defaults; only explicit typed
evidence that no safe baseline exists may block startup. Observation is finite without placing a
deadline on the Appearance effect, whose operational failure is now scoped `apply-appearance`
health with exact restart recovery.

Configuration reset remains the exact exported catalogue rather than becoming a global local-data
wipe. Its `DEFAULTS` gate precedes both Advanced Settings and startup recovery. The command owns a
value-free per-entry ledger, retains Promise setters beyond observation cancellation or timeout,
preserves completed entries, and retries only outstanding entries. Drafts, Account registry, the
push applied-id ledger, and per-Account Space ordering stay excluded; Room ordering instead uses
its own per-Account hydration health and the recent-activity default.

The Privacy journey follows the same policy boundary through the shared catalog renderer. Its
descriptors are defined and exported by the Conversations capability in
`@trinity/data-access/timeline`. The capability contributes them to the policy-free catalog; the
application composition root separately binds the same descriptor set to the temporary
`PrivacySettingsService` compatibility facade. Existing callers continue to read signals while
migration proceeds under the incremental-facade decision. The Advanced configuration registry
continues through the facade, while Appearance contributes six descriptor-backed entries directly.
Portable Appearance documents therefore use only current `appearance.*` paths and current
descriptor keys. Portable format 2 maps the six former version 1 Theme paths into those current
entries on import; predecessor storage keys remain read-only migration metadata.

## Current guidance

This decision records its accepted context. See the [current architecture contract](../architecture/target-architecture.md), [capability ownership](../architecture/libraries.md) and [runtime lifetimes](../architecture/state-and-reactivity.md) for the implemented boundaries.
