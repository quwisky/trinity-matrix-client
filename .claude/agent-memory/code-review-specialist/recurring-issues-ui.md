---
name: recurring-issues-ui
description: Recurring defect patterns flagged in the Trinity UI layer — check for these in future reviews
metadata:
  type: project
---

Patterns flagged during the full UI-layer review (2026-06-27). Watch for these recurring:

- **`effect()` used for DOM/focus side-effects** that run on every dependency change, not just the intended transition. E.g. EncryptionSetupPage focuses a heading in an effect that re-runs whenever the viewChild resolves; MessageComposer guards with `wasEditing`/`wasReplying` boolean flags (the better pattern). Avatar resets `failed` in an effect keyed on `url()`. Prefer explicit transition guards or `afterRenderEffect`/`afterNextRender` for DOM work.
- **Inbound Matrix HTML** (`formatted_body`) rendered via `[innerHTML]` in message-list. It is NOT pre-sanitized in core's `renderBody()` (only OUTBOUND markdown is sanitized via DomSanitizer). Render-time Angular default sanitization is the only net — relies on a plain-string binding (no bypassSecurityTrust). Acceptable but fragile; a deliberate Matrix-aware allowlist (e.g. matrix-js-sdk sanitizer / DOMPurify) would be more robust.
- **feature-auth has NO tests** (login.page, sso-callback.page). Other feature libs have .spec.ts files. Flag missing coverage for risky auth logic.
- **`window.confirm` / `window.alert`** used for destructive confirms (message-list delete) — not Ionic-idiomatic, untestable, blocks the thread. Prefer Ionic AlertController.
- **Backfill/scroll-anchoring logic** in message-list is the most complex/fragile component (imperative state machine in an effect with rAF). Give it extra scrutiny on any change.
- **`retry` output typing:** TimelineService.retry takes a string id and returns void; rooms.page binds `(retry)="timeline.retry($event)"` directly. Confirm event payload types match output<T> declarations when reviewing message-list IO.

**Why:** These are the soft spots; re-checking them keeps review quality consistent.
**How to apply:** On any change to message-list, composer, crypto pages, or auth, check these first.
