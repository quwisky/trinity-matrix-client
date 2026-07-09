# Trinity — Voice & Video Calls Roadmap

The flagship "differentiator" track. Calls are the biggest deferred capability in
[PLAN.md](PLAN.md) and genuinely multi-week — so this plan is a **staircase**: each step ships real
value on its own, and later steps are optional depending on how far you want to go.

Companion tracks: [UX-POLISH-PLAN.md](UX-POLISH-PLAN.md) · [PARITY-PLAN.md](PARITY-PLAN.md) ·
[NATIVE-READINESS-PLAN.md](NATIVE-READINESS-PLAN.md).

Effort: **S** = <1 day · **M** = a few days · **L** = ~1–2 weeks · **XL** = multi-week, every platform.

## The staircase (each step is independently shippable)

| Step | Feature                                        | Size | Value         | Ships without…   |
| ---- | ---------------------------------------------- | ---- | ------------- | ---------------- |
| 0    | getUserMedia permission plumbing               | S    | Med (enabler) | —                |
| 1    | Voice messages (record + waveform)             | L    | High          | any WebRTC       |
| 2    | "Start call" → Element Call link/banner        | S    | High          | any in-app media |
| 3    | In-app 1:1 voice & video (MatrixCall)          | L    | High          | group/SFU infra  |
| 4    | Native incoming-call ringing (CallKit/Telecom) | XL   | High          | —                |
| 5    | Group calls via Element Call widget            | XL   | High          | —                |
| —    | Jitsi widget embed (fallback)                  | L    | Low           | LiveKit infra    |

**Recommendation:** do **Step 1 (voice messages)** and **Step 2 (Element Call link)** first. Together they
give users a real "voice" capability _and_ working group audio/video **this iteration**, for S+L effort and
zero WebRTC risk. Treat Steps 3–5 as a later, deliberate investment.

---

## Step 0 — getUserMedia permission plumbing — **S / enabler**

Hard prerequisite for _any_ in-app mic/camera. Confirmed gaps:

- `electron/src/window.ts` sets no `setPermissionRequestHandler` — the hardened window denies `media` by default.
- iOS `Info.plist` has `NSCameraUsageDescription` but **no** `NSMicrophoneUsageDescription`.
- Android manifest has `CAMERA` but **no** `RECORD_AUDIO` / `MODIFY_AUDIO_SETTINGS`.

Add the Electron media handler (scoped to the `trinity://` origin), the two native strings, and a Capacitor
runtime permission request. No user-facing feature on its own, but unblocks Steps 1, 3, 5.

## Step 1 — Voice messages — **L / High** ⭐ best ROI

The single best-value item in this domain and fully self-contained. `MediaService` already sends/plays
`m.audio` through the encrypted media path; add a hold-to-record (or tap) button in the composer that
captures opus/ogg via `MediaRecorder`, renders a live + static waveform, uploads encrypted through the
existing path, and tags the event `org.matrix.msc1767.audio` + `org.matrix.msc3245.voice` so it renders as a
voice message in Element. Reuses everything; no WebRTC, no calls complexity.

- **Native recording** (Capacitor audio plugin) is what pushes this to L; web/Electron use `MediaRecorder`.
- **Depends on:** Step 0 (mic permission).

## Step 2 — "Start call" → Element Call link — **S / High**

The cheapest path to a real call capability. A call button in the room/DM header mints a
`call.element.io` (or configured Element Call) link scoped to the room and posts it into the timeline —
optionally as an `im.vector.modular.widgets` state event so every member sees a persistent "Join call"
banner — opening in the system browser / external window. Trinity carries **zero WebRTC**, needs **no CSP
change** and **no getUserMedia**. External-browser handoff (not integrated), but gives working group A/V today.

## Step 3 — In-app 1:1 voice & video (MatrixCall) — **L / High**

First-class native calling: a new `data-access-calls` lib wrapping `client.createCall()` /
`CallEventHandler` into read-only signals, plus a `feature-calls` UI (place/answer/hangup, local + remote
`MediaStream` tiles, mute + camera toggle, incoming-call ring modal + ringtone, an `m.call.*` timeline
entry, TURN via `client.getTurnServers()`). Works in web, WebViews, and Electron once Step 0 lands.

- **Caveat:** legacy 1:1 (`MatrixCall`) is being superseded by MatrixRTC and Element is deprecating it, so
  cross-client interop narrows (best Trinity↔Trinity / older Element). Far simpler than a LiveKit SFU, though.
- **Depends on:** Step 0; a **TURN server** (homeserver-provided or self-hosted coturn). Reliable
  background ringing on mobile needs Step 4.

## Step 4 — Native incoming-call ringing — **XL / High**

What makes calls actually usable on mobile: without it, a call only rings when Trinity is foregrounded.
Requires **real native modules** (not Capacitor JS): iOS **CallKit + PushKit** VoIP pushes; Android
**ConnectionService** + a high-priority FCM channel; plus a call-notify path (`m.call.notify`, MSC4075)
fanned out through a push gateway.

- **Depends on:** Step 3 (or 5) existing; VoIP push via a deployed Sygnal-style gateway (itself deferred per
  [PUSH.md](PUSH.md)). Expensive per-platform native code.

## Step 5 — Group calls via Element Call widget — **XL / High**

The modern, Element-compatible group + 1:1 solution in one surface — and the heaviest. Requires: adding
`matrix-widget-api` (**absent** from the repo today); a widget host/iframe component driving
`ClientWidgetApi` (to-device relay, membership, capability negotiation); **relaxing the CSP** (`frame-src`
is `'none'` today) to the Element Call origin; and a MatrixRTC session backed by a **LiveKit SFU + JWT
service** (self-hosted or hosted `call.element.io`).

- **Real risk:** `getUserMedia` inside a cross-origin iframe within iOS WKWebView / Android WebView needs
  per-platform allowlisting. Genuinely multi-week and touches every platform.

## Jitsi widget embed (fallback only) — **L / Low**

An alternative lower-infra group path (post a Jitsi widget, embed `meet.jit.si`), interoperating with
Element's older Jitsi calls and avoiding LiveKit. But it still needs the widget host, the same CSP
relaxation, and the same WebView iframe-media handling — nearly as much platform work as Element Call, while
Element itself is migrating away from Jitsi. Include only if LiveKit infra is a hard blocker.

---

## Bottom line

- **This iteration (recommended):** Step 0 → Step 1 (voice messages) → Step 2 (Element Call link). High
  perceived value, low risk, no infra to run.
- **Next investment:** Step 3 (in-app 1:1) if you want an integrated native calling feel and can stand up a
  TURN server.
- **Full parity (big commitment):** Steps 4 + 5 — native ringing + Element Call group — require running
  call infra (LiveKit/SFU, VoIP push gateway) and native platform code. Scope as a dedicated milestone.
