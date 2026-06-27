---
name: csp-and-headers-gap
description: The app ships no Content-Security-Policy and no security headers; SSO baseUrl trust model — known gaps as of 2026-06-27
metadata:
  type: project
---

Security-header / CSP posture for trinity-matrix-client. Audited 2026-06-27.

**No CSP anywhere.** `apps/trinity/src/index.html` has no
`<meta http-equiv="Content-Security-Policy">`, and there is no server/header
config in the repo (build is a static SPA into `www/`, deployed externally). So
there is no second layer behind Angular's sanitizer for the message-HTML surface
(see [[xss-rendering-path]]) and no `frame-ancestors` clickjacking defense. On
native (Capacitor WKWebView/Android WebView) a CSP `<meta>` would still help.
Recommend a strict CSP (no `unsafe-inline`/`unsafe-eval` for scripts; note Ionic
injects runtime styles so `style-src` may need `unsafe-inline` or nonces) plus
`connect-src` scoped to the homeserver — but the homeserver is user-chosen at
login, so `connect-src` can't be a fixed allowlist without breaking arbitrary HS.

**SSO trust model** (libs/feature-auth): `login.page.ts` stashes the resolved
`sso.baseUrl` in `sessionStorage` and redirects to the HS SSO URL with a
redirect back to `${origin}/sso-callback` (web) or `eu.qwky.trinity://sso-callback`
(native). `sso-callback.page.ts` reads `loginToken` from the query string +
`baseUrl` from sessionStorage and exchanges them. baseUrl comes from the user's
own discovery flow (same tab/session), not from the URL, so it isn't
attacker-controlled in the normal flow. The redirect target is built from
`window.location.origin`, not reflected from input, so no open redirect. Main
residual: `loginToken` lands in the URL/history of the callback load (cleared on
success by navigateByUrl replaceUrl, but present in referrer/history briefly).

**How to apply:** If asked to add CSP, account for Ionic's runtime style
injection and the dynamic homeserver. When reviewing SSO changes, keep baseUrl
sourced from the in-session discovery (never from a query param) and keep the
post-login redirect derived from origin, not from untrusted input.
