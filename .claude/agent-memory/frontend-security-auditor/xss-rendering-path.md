---
name: xss-rendering-path
description: How Matrix message HTML reaches the DOM and what sanitizes it — the app's single highest-risk surface and its defense model
metadata:
  type: project
---

Matrix message rendering path (the top XSS surface). Audited 2026-06-27.

**Path:** SDK event -> `TimelineService.renderBody()` (libs/core/.../timeline.service.ts)
reads `content.formatted_body` raw, **does NOT sanitize incoming HTML there** ->
`MessageView.html: string | null` -> `[innerHTML]="row.html"` in
message-list.component.html (lines ~50 and ~65).

**What actually defends it:** `row.html` is a plain `string` (never a `SafeHtml`,
no `bypassSecurityTrust*` anywhere in the repo), so Angular's built-in
`SecurityContext.HTML` sanitizer runs at bind time and strips scripts / inline
handlers / `javascript:` URLs. So remote `formatted_body` XSS is mitigated by
Angular's auto-sanitizer, NOT by app code.

**Implication / fragility:** the safety is implicit. If anyone ever wraps
`row.html` in `bypassSecurityTrustHtml` (e.g. to keep an attribute Angular
strips), it becomes a stored-XSS hole over E2EE messages. Defense-in-depth would
be to sanitize incoming HTML in the service with DOMPurify too. Outgoing markdown
IS explicitly sanitized via `DomSanitizer.sanitize(SecurityContext.HTML, ...)` in
`renderMarkdown()` before send.

**Other rendered user content** (room/space/member/display names, topics, reply
previews) all goes through `{{ }}` text interpolation — auto-escaped, safe.
Avatars use SDK `getAvatarUrl(baseUrl,...)` which yields an http(s) thumbnail
URL bound to `[src]` (URL-context sanitized) — safe.

**Why:** This is the trust boundary for untrusted federated content.

**How to apply:** When reviewing message-rendering changes, block any
`bypassSecurityTrust*` on message HTML and any new `[innerHTML]` fed from event
content. Prefer adding explicit DOMPurify sanitization in TimelineService rather
than relying solely on Angular. See [[csp-and-headers-gap]] and
[[secret-token-storage]].
