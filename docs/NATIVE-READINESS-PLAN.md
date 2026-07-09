# Trinity — Ship-Readiness & Native Polish Roadmap

The work to harden Trinity for a real release across Web/PWA, iOS, Android, and Desktop (Electron):
close the open on-device verification items, stand up update/release infrastructure, add the security and
OS-integration touches users expect from a native app.

Companion tracks: [UX-POLISH-PLAN.md](UX-POLISH-PLAN.md) · [PARITY-PLAN.md](PARITY-PLAN.md) ·
[CALLS-PLAN.md](CALLS-PLAN.md) · master [PLAN.md](PLAN.md).

Effort: **S** = <1 day · **M** = a few days · **L** = ~1–2 weeks · **XL** = multi-week / separate native target.

## Prioritization

| Feature                                                   | Size | Value | Theme       |
| --------------------------------------------------------- | ---- | ----- | ----------- |
| Close the open on-device verification pass                | M    | High  | Verify      |
| Electron desktop auto-update                              | M    | High  | Release     |
| PWA "update available" prompt                             | S    | Med   | Release     |
| App-lock / biometric unlock                               | L    | High  | Security    |
| Screen-security / privacy screen (FLAG_SECURE + blur)     | M    | Med   | Security    |
| Intercept in-message link clicks (internal matrix.to nav) | M    | High  | Integration |
| OS-level matrix.to / matrix: link handling                | L    | Med   | Integration |
| Share-to-Trinity (receive shared content)                 | XL   | High  | Integration |
| Native app shortcuts / quick actions + direct-share       | M    | Med   | Integration |
| Notification quick-reply + action buttons                 | L    | Med   | Integration |
| Electron tray + global-shortcut breadth                   | M    | Med   | Integration |
| Haptic feedback on key interactions                       | S    | Low   | Polish      |

**Recommendation:** the true "can we ship?" blockers are the **on-device verification pass** and
**update infrastructure** — do those first. App-lock is the highest-value net-new native feature. The OS
integrations (share-to, deep links, shortcuts) are what make it feel _native_, in descending ROI.

---

## Verify — prove what we built actually works on device

### Close the open on-device verification pass — **M / High**

PLAN.md flags several things as built-but-unverified because they need real hardware / an authed-media
homeserver. This is the top ship-readiness item — not new features, but confirming existing ones:

- Native **media picker + save/share** (Capacitor Camera/Filesystem/Share) — needs a native rebuild + `cap sync`.
- **Android dark mode** — WebView reports OS dark mode; status-bar icon contrast on pre-edge-to-edge APIs.
- **Authenticated avatars** — against a real v1.11 authed-media homeserver.
- **PWA offline cold-start + update** flow — in a real browser.
- **macOS notifications** — need a signed + notarized build to actually deliver.

**Deliverable:** a device-test checklist run on physical iOS + Android + a notarized desktop build, closing
each item or filing concrete follow-ups.

---

## Release — update & distribution infrastructure

### Electron desktop auto-update — **M / High**

`electron-updater` + a publish channel (GitHub Releases or generic https). The macOS **notarization**
scaffold already exists; **Windows signing** is still a TODO in the builder yml. Without this, desktop users
have no upgrade path short of re-downloading.

### PWA "update available" prompt — **S / Med**

The service worker precaches the shell but there's no UX to tell users a new version is ready. Add an
`SwUpdate`-driven toast ("Update available — reload"). Cheap, closes the web/PWA update loop.

---

## Security — on-device protection

### App-lock / biometric unlock — **L / High**

A PIN + biometric gate on app resume — a baseline expectation for a messaging app holding private chats.
Mobile: `capacitor-native-biometric` (or `@aparajita/capacitor-biometric-auth`). Desktop:
`systemPreferences.promptTouchID` / Windows Hello. Web: WebAuthn. A mobile-first biometric+PIN cut is **L**;
full 4-platform parity pushes toward XL.

### Screen-security / privacy screen — **M / Med**

Hide content in the OS app switcher and block screenshots of sensitive views: Android `FLAG_SECURE`, iOS
`resignActive` blur overlay (a small native shim or a Capacitor privacy-screen plugin). Expected of a
privacy-first client.

---

## Integration — feel native to the OS

### Intercept in-message link clicks — **M / High**

Clicking a `matrix.to` room/user/message link should route **in-app** (open room / user card / jump to
event); non-Matrix links open via the platform's safe external opener. Also the foundation for OS-level deep
links below. _(Shared with the UX track — build it once.)_

### OS-level matrix.to / matrix: link handling — **L / Med**

Handle `matrix.to` / `matrix:` links opened from **outside** the app: Android **App Links** + iOS
**Universal Links**, which need hosting `.well-known/assetlinks.json` + `apple-app-site-association`. Builds
directly on the in-message permalink navigation.

### Share-to-Trinity — **XL / High**

Receive images/links/text shared **from other apps** into a room picker. Android: `capacitor-plugin-send-intent`.
iOS: a dedicated **Share Extension** target (a separate binary — the expensive part). Web: a `share_target`
manifest entry. High value, but the iOS extension is what makes it XL.

### Native app shortcuts / quick actions + direct-share — **M / Med**

Long-press app-icon shortcuts (New message, Search) and conversation **direct-share** targets (recent chats
in the OS share sheet — pairs naturally with Share-to-Trinity). Capacitor app-shortcuts plugin or a small
native shim.

### Notification quick-reply + action buttons — **L / Med**

Reply / mark-read straight from a notification. Desktop + web can ship independently; the **mobile** path is
blocked on the deferred Sygnal push gateway (see [PUSH.md](PUSH.md)).

### Electron tray + global-shortcut breadth — **M / Med**

Extend the existing tray/shortcut scaffold: unread badge in tray, quick-switcher global shortcut,
show/hide/quit menu, launch-at-login.

### Haptic feedback — **S / Low**

Light haptics on send / long-press / pull-to-refresh via Capacitor Haptics. Small native-feel polish.

---

## Recommended entry point

1. **On-device verification pass** (M) — confirm the media/dark-mode/avatars/PWA/notification items really
   work on real hardware. This is the gate to any release.
2. **Electron auto-update + PWA update prompt** (M + S) — give shipped users an upgrade path.
3. **App-lock / biometric** (L) — the highest-value net-new native feature.
4. Then OS integration by ROI: **in-app link navigation** → app shortcuts → OS deep links → share-to.
