# Production renderer contract

This suite is the semantic, responsive and geometry gate for Trinity's real production renderer.
It stores no screenshots or pixel baselines in the repository.

Run it with:

```bash
pnpm nx run trinity-e2e-web:production-renderer
```

The command creates a production build and its SHA-256 manifest before Playwright starts. Set
`TRINITY_E2E_PREBUILT_WWW=1` only to reuse a previously recorded `www/`; that path verifies the
payload against the manifest before serving it and fails closed if either has drifted.

The suite blocks the PWA service worker. Chromium otherwise routes the disposable homeserver's
self-signed TLS discovery through the worker and synthesizes a 504, which tests worker/network
behavior instead of the renderer contract this suite owns. The same production JavaScript, CSS and assets
are still served and hash-verified before they are copied into Electron and Android.

## Representative cross-cutting matrix

| Project                | Viewport/device | Appearance                |
| ---------------------- | --------------- | ------------------------- |
| wide-dark-cosy         | 1440x900        | dark Trinity, Cosy        |
| standard-amethyst-cosy | 1280x720        | dark Amethyst, Cosy       |
| tablet-light-compact   | 1024x768        | light Trinity, Compact    |
| compact-light-large    | 900x700         | light, Compact, 125% text |
| pixel-onyx-cosy        | full Pixel 5    | dark Onyx, Cosy           |
| small-light-large      | full 320x568    | light, Compact, 125% text |
| webkit-compact-light   | 900x700 WebKit  | light Trinity, Compact    |

Every project checks horizontal overflow, surface bounds, representative rendered contrast, the
production reduced-motion token contract, seeded unread content, accessible control names, picker
focus restoration and safe encryption setup. Phone profiles also enforce 44px Back and Send
targets; desktop and phone profiles verify the appropriate Settings navigation treatment. The
1024px project reaches the primary action through Tab navigation and verifies its focus indicator
under forced colours. The WebKit project launches Playwright's actual WebKit engine rather than
only adopting its user agent.

Performance JSON is diagnostic evidence stored only in ignored Playwright output. It is not a
machine-independent timing budget. Production Angular budgets remain the hard bundle-size gate.

Visual proof for UI pull requests is captured into ignored temporary/test output, uploaded directly
to the pull request, and then discarded. It must never be committed to the repository.
