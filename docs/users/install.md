# Install Trinity

Trinity is one Matrix client delivered in four forms: a web app, an Electron desktop app,
and Android and iOS apps. Choose the host that fits where you read and send messages; your
Matrix account, rooms and encryption identity travel with the account rather than with one
particular screen.

## Choose where to use it

| If you want to use Trinity on… | Start with                                             | What to expect                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A browser                      | A Trinity web deployment you trust                     | A production web deployment can be installed as a browser app when the browser offers that option. It caches the app for later use after a successful first load. |
| A desktop computer             | A package supplied by the project or your organisation | The desktop app wraps the same web client and hands browser-based sign-in back to the app.                                                                        |
| An Android or iOS device       | An app supplied by the project or your organisation    | The mobile apps run the same client in a native host and use the device browser for provider sign-in.                                                             |

There is currently no published GitHub release for this repository and no official hosted
Trinity URL documented here. If someone has invited you to use Trinity, use the deployment or
installer they provide and ask them which homeserver to use. Do not enter your Matrix password
into an unrelated site that merely uses the Trinity name.

## Check the host requirements

The current web build targets the following browser engines:

| Host                       | Current requirement                                                  |
| -------------------------- | -------------------------------------------------------------------- |
| Web or desktop browser     | Chrome, Edge or Firefox 119 or later; Safari 17 or later             |
| Android browser or WebView | Chrome/Android WebView 119 or later                                  |
| iPhone or iPad browser     | Safari/iOS 17 or later                                               |
| Android source project     | Android API level 24 or later, plus the WebView requirement above    |
| iOS source project         | iOS 16.4 or later, plus the Safari/iOS 17 renderer requirement above |

The Android and iOS project minima only state where the native projects can be installed; they
do not lower the browser engine requirements for the client itself. The [web](../platforms/web.md),
[desktop](../platforms/desktop.md) and [mobile](../platforms/mobile.md) guides cover host-specific
behaviour and constraints.

## Building from source

Building from source is the usable route while this repository has no published package. It
requires Node `^24.15.0` and the pinned pnpm 11.19.0. From a checked-out repository, enable
Corepack once, install the workspace, then start the web host:

```bash
corepack enable
pnpm install
pnpm start
```

The local web app is served at `http://localhost:4200`. For a local desktop host, run
`pnpm electron:install` once and then `pnpm electron:start`. For native hosts, Android requires
the Android SDK and `pnpm android:run`; iOS requires macOS and Xcode and uses `pnpm ios:run`.
The [getting-started guide](../contributing/getting-started.md) and
[platform guides](../platforms/index.md) contain the toolchain and packaging details.

Once a source build is running, it opens at the sign-in screen. Continue with
[signing in](signing-in.md); do not treat a local development server as a public deployment.

## Install the web app when your browser offers it

The production web build includes an installable web-app manifest and a service worker. Browser
wording differs: look for an install action in the address bar or browser menu; on iPhone and
iPad, use Safari's share sheet and **Add to Home Screen** when it is available.

An installed web app still depends on its original site. It is useful for launching Trinity in
its own window and retaining the application shell, but it does not make a homeserver,
internet access, or first-time sign-in available offline.

## If installation or startup does not work

| What you see                                    | What to do                                                                                                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| You cannot find an official download or website | There is no published repository release or official hosted URL documented at present. Ask the project or organisation that directed you here for the intended deployment. |
| The browser has no install option               | Continue in the browser. Installation is offered by the browser and deployment; it is not required to use the web client.                                                  |
| A desktop or mobile package will not open       | Check the relevant [desktop](../platforms/desktop.md) or [mobile](../platforms/mobile.md) guidance, then ask the package provider for a supported build.                   |
| A source build fails before Trinity opens       | Follow [Getting started](../contributing/getting-started.md) and [troubleshooting](../reference/troubleshooting.md). Those pages own build and toolchain instructions.     |
| Trinity opens but you cannot enter an account   | Go to [signing in](signing-in.md). The next useful fact is the homeserver and the method it offers, not a reinstall.                                                       |

After you establish an account, continue to [encryption and verification](encryption.md) before
relying on a new device for encrypted history.
