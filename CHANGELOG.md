# Changelog

All notable changes to this project are documented here. release-please writes each
entry from Conventional Commit subjects when a stable release is cut, and this project
adheres to [Semantic Versioning](https://semver.org/).

## [0.4.0](https://github.com/quwisky/trinity-matrix-client/compare/v0.3.0...v0.4.0) (2026-10-12)


### ⚠ BREAKING CHANGES

* **app:** Trinity is a new app to the stores and operating systems: existing installs don't update into it, desktop users sign in again, links and SSO callbacks on the eu.qwky.trinity:// scheme no longer open Trinity, and push gateways must list dev.trinityproject.trinity.ios and dev.trinityproject.trinity.android.

### Added

* **app:** move Trinity's identifiers to dev.trinityproject ([#1147](https://github.com/quwisky/trinity-matrix-client/issues/1147)) ([145069f](https://github.com/quwisky/trinity-matrix-client/commit/145069f31bd34af69cf2a2c3320cd2e7709c7d67))
* **composer:** take photos and record videos from the composer ([#1142](https://github.com/quwisky/trinity-matrix-client/issues/1142)) ([9db3b67](https://github.com/quwisky/trinity-matrix-client/commit/9db3b67604cad5fefab23497ee148d7386eefea7))
* **diagnostics:** report a bug with a redacted diagnostic log ([#1248](https://github.com/quwisky/trinity-matrix-client/issues/1248)) ([37242f2](https://github.com/quwisky/trinity-matrix-client/commit/37242f240d454776b3b0249e86104bd609fb3e8d))
* **media:** cap uploads when the homeserver states no size limit ([#1169](https://github.com/quwisky/trinity-matrix-client/issues/1169)) ([0a75a90](https://github.com/quwisky/trinity-matrix-client/commit/0a75a9054c9f17768e273e5c88857a93d8abef47))
* **media:** check a gallery photo's size before reading it ([#1190](https://github.com/quwisky/trinity-matrix-client/issues/1190)) ([ec0b7b3](https://github.com/quwisky/trinity-matrix-client/commit/ec0b7b3ab9f53f3ff50a0bdc907588fefa65d787)), refs [#1177](https://github.com/quwisky/trinity-matrix-client/issues/1177)
* **media:** remove location and camera metadata from uploaded photos ([#1170](https://github.com/quwisky/trinity-matrix-client/issues/1170)) ([1d35560](https://github.com/quwisky/trinity-matrix-client/commit/1d35560c2422b1535fbd270f4f2a47e56df3f802))
* **media:** strip location metadata from uploaded videos ([#1192](https://github.com/quwisky/trinity-matrix-client/issues/1192)) ([f9ba2a9](https://github.com/quwisky/trinity-matrix-client/commit/f9ba2a9705c07e992a69ae1ff8d60fb71e4a3dff))
* **media:** strip metadata from gif, tiff and svg uploads ([#1193](https://github.com/quwisky/trinity-matrix-client/issues/1193)) ([6596fbc](https://github.com/quwisky/trinity-matrix-client/commit/6596fbc1a63f6af2f797a4b5ead5d7ef2ac477bd))
* **notifications:** render mobile push on the device ([#1157](https://github.com/quwisky/trinity-matrix-client/issues/1157)) ([d80f5dd](https://github.com/quwisky/trinity-matrix-client/commit/d80f5dd88d92f11516bac5345e375d718629cebc))
* **push:** show why a closed-app push has no preview ([#1206](https://github.com/quwisky/trinity-matrix-client/issues/1206)) ([fbb7ac1](https://github.com/quwisky/trinity-matrix-client/commit/fbb7ac15ba4be667b148da79eda8470742c155d3))
* **rooms:** list the rail's overflow unread chats from +N ([#1137](https://github.com/quwisky/trinity-matrix-client/issues/1137)) ([66c4675](https://github.com/quwisky/trinity-matrix-client/commit/66c46751860b4b6ca2bf8c58c3081fac6d86320c))
* **rooms:** open a rail unread chat in a list that shows it ([#1135](https://github.com/quwisky/trinity-matrix-client/issues/1135)) ([a2f9032](https://github.com/quwisky/trinity-matrix-client/commit/a2f903227295b31d785fa5b2e81f179724fc90c4)), refs [#1126](https://github.com/quwisky/trinity-matrix-client/issues/1126)
* **rooms:** open member info as a dialog or a sheet over the list ([#1171](https://github.com/quwisky/trinity-matrix-client/issues/1171)) ([037b7f7](https://github.com/quwisky/trinity-matrix-client/commit/037b7f7f7198428f9bababfb26ba76ac364a140f))
* **rooms:** show unread chats from every account in the space rail ([#1125](https://github.com/quwisky/trinity-matrix-client/issues/1125)) ([588d179](https://github.com/quwisky/trinity-matrix-client/commit/588d179366439c2bd4b3449fc0955c2face5eb72))
* **runtime:** report a bug from the desktop title bar ([#1253](https://github.com/quwisky/trinity-matrix-client/issues/1253)) ([dbde134](https://github.com/quwisky/trinity-matrix-client/commit/dbde1343a82ce8b9c1c885f56768095d7761da62))
* **settings:** add a privacy setting to keep photo metadata ([#1191](https://github.com/quwisky/trinity-matrix-client/issues/1191)) ([14edd27](https://github.com/quwisky/trinity-matrix-client/commit/14edd278708637578c35fc2021dfc2085ece229a))
* **trust:** lead verification without another device to Security ([#1240](https://github.com/quwisky/trinity-matrix-client/issues/1240)) ([c1fc1fc](https://github.com/quwisky/trinity-matrix-client/commit/c1fc1fce63f9cd1aa862ee370a6b5ceb56c76762))
* **ui:** invert solid actions on accent page headers and overlays ([#1239](https://github.com/quwisky/trinity-matrix-client/issues/1239)) ([5bf9391](https://github.com/quwisky/trinity-matrix-client/commit/5bf9391048cc1ad24796ea74546e4ab2f59c048d))
* **ui:** support form controls on accent attention surfaces ([#1243](https://github.com/quwisky/trinity-matrix-client/issues/1243)) ([a33b70b](https://github.com/quwisky/trinity-matrix-client/commit/a33b70bf1b5f064e67a13ac7c0f12afaa0cf0dad))
* **ui:** support the remaining controls on accent attention surfaces ([#1245](https://github.com/quwisky/trinity-matrix-client/issues/1245)) ([a6d3724](https://github.com/quwisky/trinity-matrix-client/commit/a6d3724d77f3f0f58025fd6ca98740fc5dbc158e))


### Fixed

* **accounts:** ignore token refreshes from a replaced client ([#1233](https://github.com/quwisky/trinity-matrix-client/issues/1233)) ([58ff248](https://github.com/quwisky/trinity-matrix-client/commit/58ff2483cf10e379ead332ad938bc80be93d728e))
* **composer:** keep a selection made right after a Format menu action ([#1148](https://github.com/quwisky/trinity-matrix-client/issues/1148)) ([1ab990c](https://github.com/quwisky/trinity-matrix-client/commit/1ab990ca7fb6634fe65b3669390d99ec5b7c5d72))
* **deps:** update Capacitor to 8.5.3 and its plugins to their latest patches ([#1119](https://github.com/quwisky/trinity-matrix-client/issues/1119)) ([7a48b41](https://github.com/quwisky/trinity-matrix-client/commit/7a48b41d62211d99662462a55f619c29f8b941ff))
* **desktop:** stop timeline areas going blank under the pointer ([#1212](https://github.com/quwisky/trinity-matrix-client/issues/1212)) ([c351291](https://github.com/quwisky/trinity-matrix-client/commit/c3512916aeb2c70ce088fde343a58bcd37a13b61))
* **diagnostics:** replace names and email addresses in bug-report logs ([#1255](https://github.com/quwisky/trinity-matrix-client/issues/1255)) ([1165495](https://github.com/quwisky/trinity-matrix-client/commit/116549591516425d54086f70c7efdb23482d1e60))
* **logging:** keep matrix-js-sdk debug output out of production ([#1234](https://github.com/quwisky/trinity-matrix-client/issues/1234)) ([261efbe](https://github.com/quwisky/trinity-matrix-client/commit/261efbe948062eb2ca77248f8bb9b7c5590bbf85))
* **media:** keep a room's stickers current after an image-pack change ([#1197](https://github.com/quwisky/trinity-matrix-client/issues/1197)) ([3059d11](https://github.com/quwisky/trinity-matrix-client/commit/3059d11e5a74138e8593c3a19e941db94d55092c)), refs [#1194](https://github.com/quwisky/trinity-matrix-client/issues/1194)
* **media:** stop reporting a dismissed share sheet as a saved file ([#1249](https://github.com/quwisky/trinity-matrix-client/issues/1249)) ([a502ce7](https://github.com/quwisky/trinity-matrix-client/commit/a502ce760fbec1fb726be80a0ae9a95a733bb36a))
* **mobile:** allow the iOS swipe-back gesture on routed pages ([#1114](https://github.com/quwisky/trinity-matrix-client/issues/1114)) ([d719638](https://github.com/quwisky/trinity-matrix-client/commit/d71963863396b9f3a546bf14c2374055dbaf0253)), refs [#971](https://github.com/quwisky/trinity-matrix-client/issues/971)
* **mobile:** launch on iOS 27 by adopting the scene lifecycle ([#1106](https://github.com/quwisky/trinity-matrix-client/issues/1106)) ([e34fd98](https://github.com/quwisky/trinity-matrix-client/commit/e34fd98085673ebd82111262e6aa9d8ff0cdeb92))
* **mobile:** swipe back from a phone conversation to the room list ([#1121](https://github.com/quwisky/trinity-matrix-client/issues/1121)) ([8043b96](https://github.com/quwisky/trinity-matrix-client/commit/8043b96ece3e73ab28a78c0dcd2b21e2df5f08e1))
* **native:** drop a picked photo the device can't read instead of sending an error page ([#1144](https://github.com/quwisky/trinity-matrix-client/issues/1144)) ([3d273a0](https://github.com/quwisky/trinity-matrix-client/commit/3d273a0afa27d497d8956a0dafc48462ffb05cda)), refs [#1141](https://github.com/quwisky/trinity-matrix-client/issues/1141)
* **native:** keep plugin arguments out of debug device logs ([#1164](https://github.com/quwisky/trinity-matrix-client/issues/1164)) ([25a62b5](https://github.com/quwisky/trinity-matrix-client/commit/25a62b54afec4a08e4b92aa4ee29d891369b9d1c))
* **native:** strip xml comments until none are left in the host contract ([#1200](https://github.com/quwisky/trinity-matrix-client/issues/1200)) ([a9f58e1](https://github.com/quwisky/trinity-matrix-client/commit/a9f58e1aa1e8ea46dc5a217d7aaeffbe0cef6c8e))
* **push:** keep ios push handoff tokens on this device ([#1203](https://github.com/quwisky/trinity-matrix-client/issues/1203)) ([69d482f](https://github.com/quwisky/trinity-matrix-client/commit/69d482f93391b7631c419ea7041e4075eb91a8b4))
* **rooms:** keep a just-added address when an older list read answers ([#1228](https://github.com/quwisky/trinity-matrix-client/issues/1228)) ([36e3b2a](https://github.com/quwisky/trinity-matrix-client/commit/36e3b2a1962265f44fac494a3113f376b21bf822))
* **rooms:** keep quick reactions open while the pointer reaches them ([#1232](https://github.com/quwisky/trinity-matrix-client/issues/1232)) ([2a9d69b](https://github.com/quwisky/trinity-matrix-client/commit/2a9d69bdcad947158eede01be4e43a5050059a2c))
* **rooms:** move a room up the list when a thread gets a reply ([#1237](https://github.com/quwisky/trinity-matrix-client/issues/1237)) ([d14fdf6](https://github.com/quwisky/trinity-matrix-client/commit/d14fdf6fcab67beafb6fe76bb31f08e148aa6bc0))
* **settings:** show the stored value again after a failed save ([#1132](https://github.com/quwisky/trinity-matrix-client/issues/1132)) ([1581c6a](https://github.com/quwisky/trinity-matrix-client/commit/1581c6a6c29eb38934a75319b55f876b0039e058))
* **trust:** never replace an existing encryption identity from setup ([#1214](https://github.com/quwisky/trinity-matrix-client/issues/1214)) ([1f9ad0d](https://github.com/quwisky/trinity-matrix-client/commit/1f9ad0d4f41e9f3d7e67405aaea9ca8edd7e1d80))
* **trust:** publish the identity when a first setup is retried ([#1231](https://github.com/quwisky/trinity-matrix-client/issues/1231)) ([01a99c1](https://github.com/quwisky/trinity-matrix-client/commit/01a99c18b17c207f7222275d69cdbce3466d572a))
* **ui:** keep tooltips closed when focus returns after a touch ([#1226](https://github.com/quwisky/trinity-matrix-client/issues/1226)) ([2ed6677](https://github.com/quwisky/trinity-matrix-client/commit/2ed6677fac77bcd1fd0bdd08130ac3483abd3b72))
* **ui:** make buttons in an accent banner visible as buttons ([#1220](https://github.com/quwisky/trinity-matrix-client/issues/1220)) ([d6e3177](https://github.com/quwisky/trinity-matrix-client/commit/d6e31773ee78731712ceeb87f9d49f3033a521d6))
* **ui:** return focus to the control that opened a dialog on iOS ([#1111](https://github.com/quwisky/trinity-matrix-client/issues/1111)) ([62ed20f](https://github.com/quwisky/trinity-matrix-client/commit/62ed20f4a019796f04fdbe7ae28adadf7fb049d6)), refs [#1109](https://github.com/quwisky/trinity-matrix-client/issues/1109)
* **ui:** wrap banner actions below the message on narrow screens ([#1222](https://github.com/quwisky/trinity-matrix-client/issues/1222)) ([7bd02ca](https://github.com/quwisky/trinity-matrix-client/commit/7bd02ca2b6f8d465e36aed07cdf9ea984189f5f5))
* **widgets:** time out a hung widget runtime load ([#1186](https://github.com/quwisky/trinity-matrix-client/issues/1186)) ([1284ac6](https://github.com/quwisky/trinity-matrix-client/commit/1284ac62de193d25e05bb39ecf0b15941bec72f3))


### Changed

* **composer:** open the camera without waiting for the upload limit ([#1149](https://github.com/quwisky/trinity-matrix-client/issues/1149)) ([412e6b9](https://github.com/quwisky/trinity-matrix-client/commit/412e6b9420b8903a095a6ea5675339640658deed))
* **desktop:** cap compositor tile memory ([#1057](https://github.com/quwisky/trinity-matrix-client/issues/1057)) ([3ac5d58](https://github.com/quwisky/trinity-matrix-client/commit/3ac5d581b825524767f6cbb3b4b5e75406215fff))
* **widgets:** load matrix-widget-api only when a widget opens ([#1172](https://github.com/quwisky/trinity-matrix-client/issues/1172)) ([63b012d](https://github.com/quwisky/trinity-matrix-client/commit/63b012d0bf10c8e6d9364379a4f49ce6a95ec752)), refs [#1034](https://github.com/quwisky/trinity-matrix-client/issues/1034)

## [0.3.0](https://github.com/quwisky/trinity-matrix-client/compare/v0.2.0...v0.3.0) (2026-10-09)


### Added

* **desktop:** themed title row in place of the system title bar ([#1001](https://github.com/quwisky/trinity-matrix-client/issues/1001)) ([547f8f6](https://github.com/quwisky/trinity-matrix-client/commit/547f8f6fd675734a40802eea58b724d71ad978ef))
* **rooms:** refreshed conversation header and side panels ([#1009](https://github.com/quwisky/trinity-matrix-client/issues/1009)) ([dd35b4d](https://github.com/quwisky/trinity-matrix-client/commit/dd35b4dc7b4920962a27c63d856fea5d5a293a1d))
* **rooms:** refreshed server rail, room rows and floating user panel ([#1005](https://github.com/quwisky/trinity-matrix-client/issues/1005)) ([55ba5d7](https://github.com/quwisky/trinity-matrix-client/commit/55ba5d7ad616a42c19f92349c07a09ccdf4c9e71))
* **rooms:** save images and videos from the timeline ([#1025](https://github.com/quwisky/trinity-matrix-client/issues/1025)) ([80f9a24](https://github.com/quwisky/trinity-matrix-client/commit/80f9a24d13dc227486389292364096b6dff90272))
* **settings:** settings dialog with section sub-menus ([#1026](https://github.com/quwisky/trinity-matrix-client/issues/1026)) ([cf0ed58](https://github.com/quwisky/trinity-matrix-client/commit/cf0ed587f7e0d32854bd8aba0bf4a7638c5e8e2b))
* **theme:** Graphite default, Classic and Midnight themes, inset pane and Spacious density ([#1000](https://github.com/quwisky/trinity-matrix-client/issues/1000)) ([e673f54](https://github.com/quwisky/trinity-matrix-client/commit/e673f5447091d7d6f0a9a022b7b985c163f63ef1))
* **ui:** open every modal surface through one surface service ([#1067](https://github.com/quwisky/trinity-matrix-client/issues/1067)) ([e5dfb67](https://github.com/quwisky/trinity-matrix-client/commit/e5dfb675880b8e8bcec4fd7bc531b6071275ba5d))
* **ui:** refreshed dialogs with bottom sheets on phones ([#1020](https://github.com/quwisky/trinity-matrix-client/issues/1020)) ([51136ae](https://github.com/quwisky/trinity-matrix-client/commit/51136aef9f75ffb6edabe0bf99fe090320f925ac))


### Fixed

* **accounts:** refuse to sign in to a saved account through a different server ([e9281ee](https://github.com/quwisky/trinity-matrix-client/commit/e9281eee64946a6a836fff1e7a544c487f275e69))
* **auth:** finish OAuth sign-in only with the provider it started with ([e9281ee](https://github.com/quwisky/trinity-matrix-client/commit/e9281eee64946a6a836fff1e7a544c487f275e69))
* **auth:** keep OAuth sessions signed in when the provider does not issue a new refresh token ([44535a1](https://github.com/quwisky/trinity-matrix-client/commit/44535a182b5369542607b2cc727e6a7c63b5c317))
* **auth:** keep sessions and encryption keys through temporary server errors, and offer key export before removing an account or signing in again as a new device ([e9281ee](https://github.com/quwisky/trinity-matrix-client/commit/e9281eee64946a6a836fff1e7a544c487f275e69))
* **auth:** OAuth sign-in through MAS needs Synapse 1.138 or newer; on an older Synapse with MAS, accounts are signed out and lose their local encryption keys, so turn on key backup before updating ([44535a1](https://github.com/quwisky/trinity-matrix-client/commit/44535a182b5369542607b2cc727e6a7c63b5c317))
* **auth:** revoke an OAuth session only once when signing out ([44535a1](https://github.com/quwisky/trinity-matrix-client/commit/44535a182b5369542607b2cc727e6a7c63b5c317))
* **ci:** regenerate the dependency map and de-flake three e2e tests ([#1088](https://github.com/quwisky/trinity-matrix-client/issues/1088)) ([cb5457f](https://github.com/quwisky/trinity-matrix-client/commit/cb5457f07a5a8ede7a5dcb1387129f48e11605dc))
* **ci:** stop pushes from cancelling the weekly scheduled E2E run ([#1096](https://github.com/quwisky/trinity-matrix-client/issues/1096)) ([36b109f](https://github.com/quwisky/trinity-matrix-client/commit/36b109f082475b18233ae2ca72845d30ae9b2cd8))
* **crypto:** encrypt this device's stored encryption keys for new sign-ins ([e9281ee](https://github.com/quwisky/trinity-matrix-client/commit/e9281eee64946a6a836fff1e7a544c487f275e69))
* **crypto:** explain verification requests from new sessions as a new sign-in ([e9281ee](https://github.com/quwisky/trinity-matrix-client/commit/e9281eee64946a6a836fff1e7a544c487f275e69))
* **deps:** update dependency matrix-widget-api to v1.20.0 ([#1079](https://github.com/quwisky/trinity-matrix-client/issues/1079)) ([ec9e3b0](https://github.com/quwisky/trinity-matrix-client/commit/ec9e3b084788d115cf57e83e28eb9b16cdd45f21))
* **deps:** update shiki monorepo to v4.5.0 ([#1080](https://github.com/quwisky/trinity-matrix-client/issues/1080)) ([a4a25bf](https://github.com/quwisky/trinity-matrix-client/commit/a4a25bfe0106d8c9b746a95aa26ed3552e6d5578))
* **desktop:** hide to the tray when the page calls window.close() ([#1042](https://github.com/quwisky/trinity-matrix-client/issues/1042)) ([a077545](https://github.com/quwisky/trinity-matrix-client/commit/a077545a8f5c595786ef70a72561aace288e7033))
* **docs:** keep the search index complete after the docs build ([#1043](https://github.com/quwisky/trinity-matrix-client/issues/1043)) ([2c8cded](https://github.com/quwisky/trinity-matrix-client/commit/2c8cdede36ba9eb48406c9cae97653141fa820f2))
* harden sign-in, stored keys and message display ([e9281ee](https://github.com/quwisky/trinity-matrix-client/commit/e9281eee64946a6a836fff1e7a544c487f275e69))
* **media:** show attachments, thumbnails, stickers and GIF previews only with display-safe media types ([e9281ee](https://github.com/quwisky/trinity-matrix-client/commit/e9281eee64946a6a836fff1e7a544c487f275e69))
* **rooms:** keep a thread's draft when switching threads mid-edit ([#1086](https://github.com/quwisky/trinity-matrix-client/issues/1086)) ([a6d250c](https://github.com/quwisky/trinity-matrix-client/commit/a6d250ca6c68b11e5a8d5c086f624e3f8d27066e)), refs [#1051](https://github.com/quwisky/trinity-matrix-client/issues/1051)
* **rooms:** open room widgets in the browser on Android and iOS ([e9281ee](https://github.com/quwisky/trinity-matrix-client/commit/e9281eee64946a6a836fff1e7a544c487f275e69))
* **settings:** wrap unstable features across the row, repair the Synapse nightly ([#1097](https://github.com/quwisky/trinity-matrix-client/issues/1097)) ([1c5957f](https://github.com/quwisky/trinity-matrix-client/commit/1c5957ff81302d91633275202c02873757f9d528))
* **timeline:** mark messages sent without end-to-end encryption in encrypted rooms ([e9281ee](https://github.com/quwisky/trinity-matrix-client/commit/e9281eee64946a6a836fff1e7a544c487f275e69))
* **ui:** shared cards, banners and empty states, error toasts and invite previews ([#1099](https://github.com/quwisky/trinity-matrix-client/issues/1099)) ([b643a55](https://github.com/quwisky/trinity-matrix-client/commit/b643a55f5da6f3c697bca347071e13fd9b335718))


### Changed

* **media:** bound the avatar and media caches and load timeline images lazily ([#1024](https://github.com/quwisky/trinity-matrix-client/issues/1024)) ([a8a9678](https://github.com/quwisky/trinity-matrix-client/commit/a8a96784c15b9da2da5813ddfb996edea5fd3567))
* **media:** downscale encrypted images that arrive without a thumbnail ([#1033](https://github.com/quwisky/trinity-matrix-client/issues/1033)) ([ef92157](https://github.com/quwisky/trinity-matrix-client/commit/ef92157fefc425bb0745fdba3da1b8861f1eeaae)), refs [#1016](https://github.com/quwisky/trinity-matrix-client/issues/1016)
* **platform-native:** load the QR library on first use ([#1035](https://github.com/quwisky/trinity-matrix-client/issues/1035)) ([a761b69](https://github.com/quwisky/trinity-matrix-client/commit/a761b69016098ec5fcf99c8c0ec6f3b4f75e99e4)), refs [#1016](https://github.com/quwisky/trinity-matrix-client/issues/1016)
* **rooms:** cheaper timeline row builds ([#1030](https://github.com/quwisky/trinity-matrix-client/issues/1030)) ([fec2bb6](https://github.com/quwisky/trinity-matrix-client/commit/fec2bb6292d9de91064e61d903642526077950d5))
* **rooms:** highlight code blocks lazily from a directive ([#1031](https://github.com/quwisky/trinity-matrix-client/issues/1031)) ([6721ac8](https://github.com/quwisky/trinity-matrix-client/commit/6721ac858e921e6ec0e6162fb3e8b42cec832245))
* **rooms:** load the emoji picker and its index on demand ([#1029](https://github.com/quwisky/trinity-matrix-client/issues/1029)) ([e579499](https://github.com/quwisky/trinity-matrix-client/commit/e579499396d17bad00103f1dd3a46c156b99e872))
* **rooms:** load video and audio only when played ([#1059](https://github.com/quwisky/trinity-matrix-client/issues/1059)) ([4a989d1](https://github.com/quwisky/trinity-matrix-client/commit/4a989d1ce91ad55927c00696349b77ea0d7ad87e))
* **shell:** free memory a minute after the app goes to the background ([#1058](https://github.com/quwisky/trinity-matrix-client/issues/1058)) ([6e80563](https://github.com/quwisky/trinity-matrix-client/commit/6e805635e8fbaabd419463082489d453426c1312))
* **shell:** give routed pages a class instead of a sibling selector ([#1032](https://github.com/quwisky/trinity-matrix-client/issues/1032)) ([80c8e6b](https://github.com/quwisky/trinity-matrix-client/commit/80c8e6b5c9ce147df4bb95b7966deb1bb8827d78))
* **ui:** draw the avatar ring without a blend mode ([#1021](https://github.com/quwisky/trinity-matrix-client/issues/1021)) ([18e7de4](https://github.com/quwisky/trinity-matrix-client/commit/18e7de407634900a65b45daa2327780867c9b89c))

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
