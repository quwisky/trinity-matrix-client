# Changelog

All notable changes to this project are documented here. release-please writes each
entry from Conventional Commit subjects when a stable release is cut, and this project
adheres to [Semantic Versioning](https://semver.org/).

## [0.2.1](https://github.com/quwisky/trinity-matrix-client/compare/v0.2.0...v0.2.1) (2026-10-06)


### Fixed

* **release:** verify stable tags cut from a pinned release branch ([#1010](https://github.com/quwisky/trinity-matrix-client/issues/1010)) ([#1013](https://github.com/quwisky/trinity-matrix-client/issues/1013)) ([90a114d](https://github.com/quwisky/trinity-matrix-client/commit/90a114d2346bc5f22f22bfb5c9f742775c12d88d))

## [0.2.0](https://github.com/quwisky/trinity-matrix-client/compare/v0.1.1...v0.2.0) (2026-10-06)


### Added

* **mobile:** open a room from an eu.qwky.trinity link ([#913](https://github.com/quwisky/trinity-matrix-client/issues/913)) ([2588e80](https://github.com/quwisky/trinity-matrix-client/commit/2588e80ed6f565e72e626e7641a0359df0f6ac4a)), closes [#862](https://github.com/quwisky/trinity-matrix-client/issues/862)
* **rooms:** show a room's ID, version and state in room settings ([#970](https://github.com/quwisky/trinity-matrix-client/issues/970)) ([0d93b29](https://github.com/quwisky/trinity-matrix-client/commit/0d93b29a8c60dec5f2fda9442133016466d75f4f))
* **rooms:** show truthful loading, error and empty timeline states ([#966](https://github.com/quwisky/trinity-matrix-client/issues/966)) ([c3ad19e](https://github.com/quwisky/trinity-matrix-client/commit/c3ad19ef61d9eede9cd76c39830edfba0b2831cf))
* **rooms:** upgrade a room to a newer room version ([#983](https://github.com/quwisky/trinity-matrix-client/issues/983)) ([860f49a](https://github.com/quwisky/trinity-matrix-client/commit/860f49a0b2e6a27a4f7dda1ca1c8cdbef184ffc2))
* **timeline:** collapse system runs, cap prose width and tidy timestamps ([#991](https://github.com/quwisky/trinity-matrix-client/issues/991)) ([ed243e3](https://github.com/quwisky/trinity-matrix-client/commit/ed243e38d6fc3e6808810098493db19ce8816cc6))


### Fixed

* **a11y:** stop reduced-motion transitions from delaying layout reads ([#964](https://github.com/quwisky/trinity-matrix-client/issues/964)) ([8ea4705](https://github.com/quwisky/trinity-matrix-client/commit/8ea4705d7dd83a39dc7c6f54cb09fb36f389aa83)), closes [#962](https://github.com/quwisky/trinity-matrix-client/issues/962)
* **auth:** retry homeserver discovery after a slow or dropped request ([#979](https://github.com/quwisky/trinity-matrix-client/issues/979)) ([a0cc06f](https://github.com/quwisky/trinity-matrix-client/commit/a0cc06f08835683e4bbcc7036d0a8e0f04108454)), closes [#978](https://github.com/quwisky/trinity-matrix-client/issues/978)
* **auth:** show the password toggle inside the password field ([#981](https://github.com/quwisky/trinity-matrix-client/issues/981)) ([58351b0](https://github.com/quwisky/trinity-matrix-client/commit/58351b0df692059ca36b6f924d9d0904024e4ec3))
* **desktop:** only notify about updates on the installed release channel ([#1003](https://github.com/quwisky/trinity-matrix-client/issues/1003)) ([bccd1b1](https://github.com/quwisky/trinity-matrix-client/commit/bccd1b18060fdc7fe592762df8ccdabb78da7781))
* **mobile:** open a cold-start room link in one preview, not two ([#980](https://github.com/quwisky/trinity-matrix-client/issues/980)) ([ff6b222](https://github.com/quwisky/trinity-matrix-client/commit/ff6b22227d83381d186b49688a171c7f8834c43d))
* **mobile:** open an event link that launches the app once the room list has synced ([#924](https://github.com/quwisky/trinity-matrix-client/issues/924)) ([c314b73](https://github.com/quwisky/trinity-matrix-client/commit/c314b7305641e23237d05c3d6b37fc401404dd18))
* **mobile:** stop touch devices from zooming into small text fields ([#976](https://github.com/quwisky/trinity-matrix-client/issues/976)) ([1ab3de1](https://github.com/quwisky/trinity-matrix-client/commit/1ab3de1d2478fad25249846df928816adc3813ac))
* **rooms:** keep a linked room that hasn't synced yet and show it loading ([#999](https://github.com/quwisky/trinity-matrix-client/issues/999)) ([a6339a2](https://github.com/quwisky/trinity-matrix-client/commit/a6339a289dac76e9acdcaf6e218faaecc835efdc))
* **timeline:** land a date jump on its message when history restore moves the list first ([#977](https://github.com/quwisky/trinity-matrix-client/issues/977)) ([2f5e6f6](https://github.com/quwisky/trinity-matrix-client/commit/2f5e6f66b0211ab84a1f30932c880e5d751f37b6))
* **timeline:** open a long room at its latest message with reduced motion on ([#961](https://github.com/quwisky/trinity-matrix-client/issues/961)) ([2650dab](https://github.com/quwisky/trinity-matrix-client/commit/2650dab1604f8fdfa82e55d0c669a1dcf3cc040a))
* **timeline:** stop a failed readiness wait from leaking a sync listener after release ([#975](https://github.com/quwisky/trinity-matrix-client/issues/975)) ([c654257](https://github.com/quwisky/trinity-matrix-client/commit/c654257d6117c1a75b587e65883dfaeb6be122d9))
* **ui:** show toast text in the app font instead of a serif fallback ([#985](https://github.com/quwisky/trinity-matrix-client/issues/985)) ([2fe0431](https://github.com/quwisky/trinity-matrix-client/commit/2fe0431eec4d6ea4750484a9385c9a613b6d6466))
* **ui:** solid destructive confirms, visible outline buttons and themed avatars ([#987](https://github.com/quwisky/trinity-matrix-client/issues/987)) ([b6ac3c7](https://github.com/quwisky/trinity-matrix-client/commit/b6ac3c7dd2d69f6fc66f5ba638f9728016009ea5))


### Changed

* **timeline:** mount the message toolbar only on the active row ([#960](https://github.com/quwisky/trinity-matrix-client/issues/960)) ([653066b](https://github.com/quwisky/trinity-matrix-client/commit/653066bd7fdf43038a0032995fcc0fa8635b303b))

## [0.1.1](https://github.com/quwisky/trinity-matrix-client/compare/v0.1.0...v0.1.1) (2026-10-04)


### Fixed

* **a11y:** stop pre-interaction invalid fields and fix 200% text, focus rings and touch targets ([#935](https://github.com/quwisky/trinity-matrix-client/issues/935)) ([f712f2f](https://github.com/quwisky/trinity-matrix-client/commit/f712f2f0a115c59693aff4ccb7b77e6f63c9e614)), closes [#928](https://github.com/quwisky/trinity-matrix-client/issues/928)
* **badge:** update the dock badge as soon as an encrypted message decrypts ([#909](https://github.com/quwisky/trinity-matrix-client/issues/909)) ([b561f22](https://github.com/quwisky/trinity-matrix-client/commit/b561f22ce53511edd55a984c64f1036be8106abd))
* **desktop:** let the video player go fullscreen ([#901](https://github.com/quwisky/trinity-matrix-client/issues/901)) ([21e09f1](https://github.com/quwisky/trinity-matrix-client/commit/21e09f1f2484a8fd9963a24e1fbc6f34cd482f32))
* **homebrew:** allowlist the prerelease cask only once the tap has it ([#900](https://github.com/quwisky/trinity-matrix-client/issues/900)) ([69746fd](https://github.com/quwisky/trinity-matrix-client/commit/69746fd0b9344161322817b50705f0b33f7f9abc))
* **homebrew:** declare the minimum macOS the way brew style now requires ([#897](https://github.com/quwisky/trinity-matrix-client/issues/897)) ([a90b288](https://github.com/quwisky/trinity-matrix-client/commit/a90b288f7d17d450f674a0d194eef82ad69b1bb0))
* **mobile:** keep the action sheet and composer placeholder within the phone screen ([#934](https://github.com/quwisky/trinity-matrix-client/issues/934)) ([451d7e6](https://github.com/quwisky/trinity-matrix-client/commit/451d7e62b339f78efee15f7ca948d6fb9e1c3b82)), closes [#929](https://github.com/quwisky/trinity-matrix-client/issues/929)
* **rooms:** list every pinned message, not only those loaded in the timeline ([#925](https://github.com/quwisky/trinity-matrix-client/issues/925)) ([5ec705d](https://github.com/quwisky/trinity-matrix-client/commit/5ec705db770b7a2fe40cc1ff43e9e991051edc2c))
* **rooms:** play videos and audio from the full file, not the thumbnail ([#895](https://github.com/quwisky/trinity-matrix-client/issues/895)) ([95bc447](https://github.com/quwisky/trinity-matrix-client/commit/95bc447d20f205dcdc88c8d3647152310cd1104b))
* **rooms:** show pinned messages by the pin icon's state instead of count badges ([#942](https://github.com/quwisky/trinity-matrix-client/issues/942)) ([bd20456](https://github.com/quwisky/trinity-matrix-client/commit/bd20456366444e171f31c5e373188a1dad2fa84a))
* **timeline:** count a just-sent thread reply once ([#939](https://github.com/quwisky/trinity-matrix-client/issues/939)) ([6454ccc](https://github.com/quwisky/trinity-matrix-client/commit/6454ccc0ddf27b34d720e3ca07babc33bdbd39f5))
* **timeline:** keep a jump from being undone by a queued history restore ([#941](https://github.com/quwisky/trinity-matrix-client/issues/941)) ([bd6a86d](https://github.com/quwisky/trinity-matrix-client/commit/bd6a86dd1f274aa9b880b17e6927883edd2aa9f2))
* **timeline:** stop gappy syncs and late history pages from breaking the pinned re-jump ([#917](https://github.com/quwisky/trinity-matrix-client/issues/917)) ([fe8101e](https://github.com/quwisky/trinity-matrix-client/commit/fe8101e604f85f745c97a40b49d0273fcff9030e))
* **ui:** make wording consistent and show friendly sign-in errors ([#937](https://github.com/quwisky/trinity-matrix-client/issues/937)) ([00c59c1](https://github.com/quwisky/trinity-matrix-client/commit/00c59c15ae40658bf9c6ec97863192c80341375b))

## [0.1.0]

Initial release.
