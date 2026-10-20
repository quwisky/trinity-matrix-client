# Changelog

All notable changes to this project are documented here. release-please writes each
entry from Conventional Commit subjects when a stable release is cut, and this project
adheres to [Semantic Versioning](https://semver.org/).

## [0.5.1](https://github.com/quwisky/trinity-matrix-client/compare/v0.5.0...v0.5.1) (2026-10-20)


### Fixed

* **container:** check static caching by rule instead of a file list ([#1651](https://github.com/quwisky/trinity-matrix-client/issues/1651)) ([#1652](https://github.com/quwisky/trinity-matrix-client/issues/1652)) ([cc78921](https://github.com/quwisky/trinity-matrix-client/commit/cc78921bc08f73aed02be2cc03b2caca10176348))

## [0.5.0](https://github.com/quwisky/trinity-matrix-client/compare/v0.4.0...v0.5.0) (2026-10-20)


### Added

* **accounts:** delete your account from Settings ([#1490](https://github.com/quwisky/trinity-matrix-client/issues/1490)) ([6376e3d](https://github.com/quwisky/trinity-matrix-client/commit/6376e3d2ef0b86597b556de4c0af592f163a1911))
* **app-lock:** hide Trinity in the app switcher while App lock is on ([#1359](https://github.com/quwisky/trinity-matrix-client/issues/1359)) ([d24ed32](https://github.com/quwisky/trinity-matrix-client/commit/d24ed325902e7d702aa723d7a0a3c2d3b39acbe1))
* **app-lock:** lock Trinity with Face ID, Touch ID or a PIN ([#1358](https://github.com/quwisky/trinity-matrix-client/issues/1358)) ([ad9a1d5](https://github.com/quwisky/trinity-matrix-client/commit/ad9a1d54ad5c607e771b3194bce3a1a1bbe31c48))
* **app-lock:** show the PIN from a button inside its field ([#1517](https://github.com/quwisky/trinity-matrix-client/issues/1517)) ([147a53b](https://github.com/quwisky/trinity-matrix-client/commit/147a53bcfc52b35613b2f8868530b7b4edc063a1))
* **auth:** add the QR sign-in flows ([#1624](https://github.com/quwisky/trinity-matrix-client/issues/1624)) ([4f767f1](https://github.com/quwisky/trinity-matrix-client/commit/4f767f1dfcbfeb2accb5d7c0046389e4d8eedf65))
* **auth:** detect servers that support QR sign-in ([#1623](https://github.com/quwisky/trinity-matrix-client/issues/1623)) ([65801fe](https://github.com/quwisky/trinity-matrix-client/commit/65801fe58b4cf6e51955a58be0831550c2fafb55))
* **auth:** sign in on a new device with a QR code ([#1625](https://github.com/quwisky/trinity-matrix-client/issues/1625)) ([02f5368](https://github.com/quwisky/trinity-matrix-client/commit/02f5368858f9856e7611c837c1e947086de7d146))
* data for the redesigned user info card ([#1637](https://github.com/quwisky/trinity-matrix-client/issues/1637)) ([ae438cd](https://github.com/quwisky/trinity-matrix-client/commit/ae438cda867a965849de204be214028c2a56e6ab))
* **desktop:** install Trinity Next alongside Trinity ([#1334](https://github.com/quwisky/trinity-matrix-client/issues/1334)) ([9182b43](https://github.com/quwisky/trinity-matrix-client/commit/9182b43bd470340343b7f3bf0d1a370fe4c9b92a))
* **desktop:** unlock Trinity with Windows Hello ([#1368](https://github.com/quwisky/trinity-matrix-client/issues/1368)) ([674f18f](https://github.com/quwisky/trinity-matrix-client/commit/674f18f8f7ec4925ed165aa8396e209f82c51603))
* **notifications:** hide notification text in closed-app pushes ([#1465](https://github.com/quwisky/trinity-matrix-client/issues/1465)) ([f5799e6](https://github.com/quwisky/trinity-matrix-client/commit/f5799e618204fe877896891a4ab3ec1b040c6b84))
* **notifications:** hide notification text while App lock is on ([#1417](https://github.com/quwisky/trinity-matrix-client/issues/1417)) ([d423813](https://github.com/quwisky/trinity-matrix-client/commit/d4238133ab6c4bbeda159bc06f4f969fa213b5b2))
* **rooms:** collapse long messages behind Show more ([#1331](https://github.com/quwisky/trinity-matrix-client/issues/1331)) ([2b9bf0b](https://github.com/quwisky/trinity-matrix-client/commit/2b9bf0bd398602fd6939736892df810e87051429))
* **rooms:** decline an invite and report its room in one step ([#1486](https://github.com/quwisky/trinity-matrix-client/issues/1486)) ([3951edd](https://github.com/quwisky/trinity-matrix-client/commit/3951edd645bb6cd3ebc7a1eb400eee3d8c8899aa))
* **rooms:** list a room in its server's directory from settings ([#1475](https://github.com/quwisky/trinity-matrix-client/issues/1475)) ([808e3c5](https://github.com/quwisky/trinity-matrix-client/commit/808e3c5aab1252fc082ab3bb1e780b7c22ffa4b1))
* **rooms:** open message links in a new tab without an opener ([#1319](https://github.com/quwisky/trinity-matrix-client/issues/1319)) ([532b81e](https://github.com/quwisky/trinity-matrix-client/commit/532b81ed30e2720f197b1791a59d05abc76ef2f9))
* **rooms:** put GIFs and stickers in the emoji panel ([#1268](https://github.com/quwisky/trinity-matrix-client/issues/1268)) ([a104338](https://github.com/quwisky/trinity-matrix-client/commit/a104338e2268e2663b51fc61a42bee3dfa9afc84))
* **rooms:** redesign the user info card with tabs ([#1640](https://github.com/quwisky/trinity-matrix-client/issues/1640)) ([bb24f18](https://github.com/quwisky/trinity-matrix-client/commit/bb24f18460db670a245c7cbf7e100e78f7db5588))
* **rooms:** render maths in messages ([#1329](https://github.com/quwisky/trinity-matrix-client/issues/1329)) ([e9635d5](https://github.com/quwisky/trinity-matrix-client/commit/e9635d5dbc9177c03fe91adbcea48c0ed3f8fc4d))
* **rooms:** report a room or a user to your server's admins ([#1476](https://github.com/quwisky/trinity-matrix-client/issues/1476)) ([2109c73](https://github.com/quwisky/trinity-matrix-client/commit/2109c73b2aaacfca492a422789dfe9ae46c4daf8))
* **rooms:** show inline images from formatted messages ([#1328](https://github.com/quwisky/trinity-matrix-client/issues/1328)) ([5769696](https://github.com/quwisky/trinity-matrix-client/commit/57696965e35118faea2c19eeb33c93b8763665cc))
* **rooms:** show sender colours and spoiler reasons in messages ([#1324](https://github.com/quwisky/trinity-matrix-client/issues/1324)) ([1063427](https://github.com/quwisky/trinity-matrix-client/commit/106342767e56c1c9cb5381260dd253a6ea494f97))
* **rooms:** sync recent emoji across devices ([#1480](https://github.com/quwisky/trinity-matrix-client/issues/1480)) ([8d0bcd3](https://github.com/quwisky/trinity-matrix-client/commit/8d0bcd381efa290ae4f2cf4fd156628654a69560))
* **rooms:** turn on encryption from room settings ([#1473](https://github.com/quwisky/trinity-matrix-client/issues/1473)) ([a9d7289](https://github.com/quwisky/trinity-matrix-client/commit/a9d72893027d8b205a861591c81c4f8ed4486d26))
* **settings:** block unwanted invites and list blocked users ([#1474](https://github.com/quwisky/trinity-matrix-client/issues/1474)) ([27e400d](https://github.com/quwisky/trinity-matrix-client/commit/27e400d2163cb6d1ee00437bd807c3b2b2e42a6b))
* **settings:** link a new device by scanning its QR code ([#1626](https://github.com/quwisky/trinity-matrix-client/issues/1626)) ([1184b8c](https://github.com/quwisky/trinity-matrix-client/commit/1184b8c57f2637fbb2161b8520e54e39fa194ab6))
* **settings:** remove the static Appearance preview ([#1263](https://github.com/quwisky/trinity-matrix-client/issues/1263)) ([b4a6d35](https://github.com/quwisky/trinity-matrix-client/commit/b4a6d35c04188bd765d2e12e189460097420d89d))
* **timeline:** explain why a message could not be decrypted ([#1260](https://github.com/quwisky/trinity-matrix-client/issues/1260)) ([b9da5d5](https://github.com/quwisky/trinity-matrix-client/commit/b9da5d5f7a43967f1539d50a28b41c36f06252dd))
* **trust:** mark accounts whose device here is unverified ([#1281](https://github.com/quwisky/trinity-matrix-client/issues/1281)) ([563b6ae](https://github.com/quwisky/trinity-matrix-client/commit/563b6ae7f53cdc852861c66818e52aa0e8e822ec))
* **trust:** verify new devices before the app opens ([#1283](https://github.com/quwisky/trinity-matrix-client/issues/1283)) ([507944f](https://github.com/quwisky/trinity-matrix-client/commit/507944f2af89dac2eaceaaff0396e96890c066d5))
* **ui:** add a trnTabs component and use it in the expression panel ([#1479](https://github.com/quwisky/trinity-matrix-client/issues/1479)) ([686e1a1](https://github.com/quwisky/trinity-matrix-client/commit/686e1a1e965c236beb234bef132786fc712d10c8))
* **whats-new:** show release notes after an update ([#1518](https://github.com/quwisky/trinity-matrix-client/issues/1518)) ([27d3a53](https://github.com/quwisky/trinity-matrix-client/commit/27d3a5361d7d793305f35c7a02a767fd0c04dd77))


### Fixed

* **accounts:** don't count a sign-out during deletion as a deletion ([#1510](https://github.com/quwisky/trinity-matrix-client/issues/1510)) ([63af745](https://github.com/quwisky/trinity-matrix-client/commit/63af74579cee16c9016440e07181fa330a86b4da))
* **accounts:** finish a repeated unconfirmed deletion when its session ends ([#1511](https://github.com/quwisky/trinity-matrix-client/issues/1511)) ([11007be](https://github.com/quwisky/trinity-matrix-client/commit/11007beb7a2009bc45aa3afa2f72ef6f765ce913))
* **accounts:** keep a new sign-in when a held logout is released ([#1595](https://github.com/quwisky/trinity-matrix-client/issues/1595)) ([142873f](https://github.com/quwisky/trinity-matrix-client/commit/142873f5c40c7c9070f327c910449a7f3fa6fbf5)), refs [#1594](https://github.com/quwisky/trinity-matrix-client/issues/1594)
* **accounts:** treat a sign-in again as settling an unconfirmed deletion ([#1593](https://github.com/quwisky/trinity-matrix-client/issues/1593)) ([154e463](https://github.com/quwisky/trinity-matrix-client/commit/154e46320a375da4f92e6bff2793cc1ee8e5ae4f)), refs [#1516](https://github.com/quwisky/trinity-matrix-client/issues/1516)
* **app-lock:** say that erasing turns off Windows Hello unlock ([#1604](https://github.com/quwisky/trinity-matrix-client/issues/1604)) ([a454a10](https://github.com/quwisky/trinity-matrix-client/commit/a454a109ca866090c5546cf3c0dfa260d1691e3d)), refs [#1488](https://github.com/quwisky/trinity-matrix-client/issues/1488)
* **deps:** repair main after [#1629](https://github.com/quwisky/trinity-matrix-client/issues/1629) and [#1630](https://github.com/quwisky/trinity-matrix-client/issues/1630) ([#1638](https://github.com/quwisky/trinity-matrix-client/issues/1638)) ([f10464b](https://github.com/quwisky/trinity-matrix-client/commit/f10464ba49b88d1434ccfd70a87859527a8b784a))
* **deps:** update angular to 22.2.3 ([#1599](https://github.com/quwisky/trinity-matrix-client/issues/1599)) ([ff3dd88](https://github.com/quwisky/trinity-matrix-client/commit/ff3dd88b40263a61398834986300a50ed2f6caa5))
* **deps:** update angular, spartan-ng and 18 more dependencies ([#1403](https://github.com/quwisky/trinity-matrix-client/issues/1403)) ([c677e42](https://github.com/quwisky/trinity-matrix-client/commit/c677e42e1a8ddf9b0a661cc28442d9ba34e6a5ea))
* **deps:** update dompurify to 3.4.17 ([#1405](https://github.com/quwisky/trinity-matrix-client/issues/1405)) ([edf1040](https://github.com/quwisky/trinity-matrix-client/commit/edf10408e3505be6c6468302db5a2610fcc373dd))
* **deps:** update electron to 44.7.0 ([#1406](https://github.com/quwisky/trinity-matrix-client/issues/1406)) ([b60b644](https://github.com/quwisky/trinity-matrix-client/commit/b60b644ce4928306b795ce55b0a9ad37415236ac))
* **desktop:** tell a renderer started in the tray that it is hidden ([#1351](https://github.com/quwisky/trinity-matrix-client/issues/1351)) ([e4f4cb8](https://github.com/quwisky/trinity-matrix-client/commit/e4f4cb8c1bafee7307b845f4a6d00b9b96825166))
* **desktop:** turn off developer tools and Reload in release builds ([#1342](https://github.com/quwisky/trinity-matrix-client/issues/1342)) ([c4fac4f](https://github.com/quwisky/trinity-matrix-client/commit/c4fac4f301e431000510d73416c4506abeb163f6))
* **diagnostics:** redact device IDs that start with digits ([#1302](https://github.com/quwisky/trinity-matrix-client/issues/1302)) ([173696b](https://github.com/quwisky/trinity-matrix-client/commit/173696b46c5d85cce38f6a9ab98c719fd6616fcd))
* **diagnostics:** redact double-encoded and partly-escaped IDs ([#1314](https://github.com/quwisky/trinity-matrix-client/issues/1314)) ([adf72da](https://github.com/quwisky/trinity-matrix-client/commit/adf72da030fa0d341f6721ebc3792dcb652c9ded))
* **diagnostics:** redact percent-encoded IDs and device IDs with punctuation ([#1309](https://github.com/quwisky/trinity-matrix-client/issues/1309)) ([4446940](https://github.com/quwisky/trinity-matrix-client/commit/44469407ea9b9f2c300673512415add54c510d18))
* **encryption:** encrypt right away in a room you just turned encryption on ([#1622](https://github.com/quwisky/trinity-matrix-client/issues/1622)) ([a3f8189](https://github.com/quwisky/trinity-matrix-client/commit/a3f8189293a735b48f288c9a6f55e09b6a71ca5d))
* **matrix:** trim trailing URL punctuation in linear time ([#1305](https://github.com/quwisky/trinity-matrix-client/issues/1305)) ([a606d30](https://github.com/quwisky/trinity-matrix-client/commit/a606d3070a75fa8343f08c1791a28695df624fae))
* **media:** free full-size media and voice clips once they are closed ([#1299](https://github.com/quwisky/trinity-matrix-client/issues/1299)) ([4769ca3](https://github.com/quwisky/trinity-matrix-client/commit/4769ca3167803f2728e2474c41c6fe0d5a6a32fb))
* **media:** use the shared server-support check for authenticated media ([#1619](https://github.com/quwisky/trinity-matrix-client/issues/1619)) ([48435d3](https://github.com/quwisky/trinity-matrix-client/commit/48435d3b9c2328f585113aecaf1bf4adaed2f925))
* **platform-native:** let sign-in save a store key without an OS keychain ([#1613](https://github.com/quwisky/trinity-matrix-client/issues/1613)) ([45051a4](https://github.com/quwisky/trinity-matrix-client/commit/45051a4b8d4e5566a18788a43b4695b7f8021aa5))
* **rooms:** confirm a block in the member card instead of a toast ([#1611](https://github.com/quwisky/trinity-matrix-client/issues/1611)) ([b0c259e](https://github.com/quwisky/trinity-matrix-client/commit/b0c259e8f2344e1d8554da6246035eb9f79c3351)), refs [#1484](https://github.com/quwisky/trinity-matrix-client/issues/1484)
* **rooms:** fetch no emoji or KaTeX for a concealed spoiler ([#1346](https://github.com/quwisky/trinity-matrix-client/issues/1346)) ([d66993b](https://github.com/quwisky/trinity-matrix-client/commit/d66993b2e6af0447ba71f621bab998f2e99909ce))
* **rooms:** free a room's older messages once nobody has it open ([#1364](https://github.com/quwisky/trinity-matrix-client/issues/1364)) ([6130af7](https://github.com/quwisky/trinity-matrix-client/commit/6130af7ae14306278c2203ff5f9dc628a75f8393))
* **rooms:** free the open room's older messages while Trinity is hidden ([#1367](https://github.com/quwisky/trinity-matrix-client/issues/1367)) ([6ea383c](https://github.com/quwisky/trinity-matrix-client/commit/6ea383ca1ad565f92e948824b1c6022f0f97ba1e))
* **rooms:** keep a space on reload and return to Recent when it goes ([#1416](https://github.com/quwisky/trinity-matrix-client/issues/1416)) ([4d137d6](https://github.com/quwisky/trinity-matrix-client/commit/4d137d64fe8a3163ec81396ddbd77e32e88f324c))
* **rooms:** keep a voice message's duration visible on narrow screens ([#1308](https://github.com/quwisky/trinity-matrix-client/issues/1308)) ([39f9a55](https://github.com/quwisky/trinity-matrix-client/commit/39f9a5573da24fc6c0d6bc65db85b6fc419a13ce))
* **rooms:** keep the space selected when opening one of its rooms ([#1400](https://github.com/quwisky/trinity-matrix-client/issues/1400)) ([9933982](https://github.com/quwisky/trinity-matrix-client/commit/993398216e6d46aa7317ca15218292a06ca4af5d))
* **rooms:** keep voice, video and audio playing when a message updates ([#1454](https://github.com/quwisky/trinity-matrix-client/issues/1454)) ([82f5ce5](https://github.com/quwisky/trinity-matrix-client/commit/82f5ce5f8bc219ade4a595cc81313360b747c6c0))
* **rooms:** mark a changed formula in the edit history as text ([#1348](https://github.com/quwisky/trinity-matrix-client/issues/1348)) ([efa265c](https://github.com/quwisky/trinity-matrix-client/commit/efa265cccce8cb1adb2b586925966d137460dc38))
* **rooms:** name a saved inline image by its type and clear the viewer ([#1352](https://github.com/quwisky/trinity-matrix-client/issues/1352)) ([b87d00c](https://github.com/quwisky/trinity-matrix-client/commit/b87d00c90956421ef40078797edef80ee606659b))
* **rooms:** name emoji reaction buttons by the emoji they show ([#1412](https://github.com/quwisky/trinity-matrix-client/issues/1412)) ([b087c58](https://github.com/quwisky/trinity-matrix-client/commit/b087c585c789097c095e4c12e772d5971648869c))
* **rooms:** open room topic and composer preview links as message links ([#1349](https://github.com/quwisky/trinity-matrix-client/issues/1349)) ([22260b9](https://github.com/quwisky/trinity-matrix-client/commit/22260b9a788117ff409742ea10b2886441aeb0ca))
* **rooms:** release Show more measurements and closed right-hand panels ([#1365](https://github.com/quwisky/trinity-matrix-client/issues/1365)) ([1b324e1](https://github.com/quwisky/trinity-matrix-client/commit/1b324e1a39aa73560f9f1ef8c3d0bc2b3a6673f4))
* **runtime:** run Trinity in one browser tab at a time ([#1298](https://github.com/quwisky/trinity-matrix-client/issues/1298)) ([6cfbb4f](https://github.com/quwisky/trinity-matrix-client/commit/6cfbb4fd665d6bec43df43736d319a82bd01caa8))
* **settings:** don't guess the account options when the server can't be asked ([#1515](https://github.com/quwisky/trinity-matrix-client/issues/1515)) ([167b4e6](https://github.com/quwisky/trinity-matrix-client/commit/167b4e6e80afb964fa7afce062e1a9dbee85b322))
* **threads:** hold thread read receipts until the window has focus ([#1363](https://github.com/quwisky/trinity-matrix-client/issues/1363)) ([b8d5c14](https://github.com/quwisky/trinity-matrix-client/commit/b8d5c140ff5403558a98d728ebd925afe32149ff))
* **timeline:** show an unblocked person's messages without a reload ([#1621](https://github.com/quwisky/trinity-matrix-client/issues/1621)) ([b0d2551](https://github.com/quwisky/trinity-matrix-client/commit/b0d25512681c44c6e1b7c37ed2cf3164801346ec))
* **ui:** keep disabled primary and danger buttons readable ([#1435](https://github.com/quwisky/trinity-matrix-client/issues/1435)) ([e56129a](https://github.com/quwisky/trinity-matrix-client/commit/e56129a027bedd24fd13ea543becab65778dae68)), refs [#1355](https://github.com/quwisky/trinity-matrix-client/issues/1355)
* **ui:** keep the encryption prompt its own height when no notice preceded it ([#1434](https://github.com/quwisky/trinity-matrix-client/issues/1434)) ([b50d1aa](https://github.com/quwisky/trinity-matrix-client/commit/b50d1aafc892f93b0f88bdbbc6b46dac148a0a0e))
* **ui:** keep the room list still while the banner slot settles at start-up ([#1443](https://github.com/quwisky/trinity-matrix-client/issues/1443)) ([7c4db13](https://github.com/quwisky/trinity-matrix-client/commit/7c4db13ea05edc5dac80930e223eb42c7a31688a))
* **ui:** separate the focus ring from solid primary buttons ([#1463](https://github.com/quwisky/trinity-matrix-client/issues/1463)) ([3f9ea93](https://github.com/quwisky/trinity-matrix-client/commit/3f9ea93030343f6602beff2b146eafb2f25795a3))
* **ui:** stop the banner swap from moving the room list on phones ([#1430](https://github.com/quwisky/trinity-matrix-client/issues/1430)) ([4d2d6c4](https://github.com/quwisky/trinity-matrix-client/commit/4d2d6c4acd99ce7014da9fbbeaf80572f63950f3))


### Changed

* **composer:** keep the emoji panel's view for a minute between opens ([#1322](https://github.com/quwisky/trinity-matrix-client/issues/1322)) ([0d56683](https://github.com/quwisky/trinity-matrix-client/commit/0d566838286e1b013b3b7c89ee0d8e459f9e3bbf))
* **composer:** render long runs of spaces in linear time ([#1323](https://github.com/quwisky/trinity-matrix-client/issues/1323)) ([75713a3](https://github.com/quwisky/trinity-matrix-client/commit/75713a3687385163b13a2165d4d172c0ceaf7ead))
* **desktop:** share one 256 px app icon between windows and notifications ([#1291](https://github.com/quwisky/trinity-matrix-client/issues/1291)) ([179bd26](https://github.com/quwisky/trinity-matrix-client/commit/179bd2606a32dcd2a0b26659f709e0d39d4a045b))
* **desktop:** stream app files instead of reading them whole ([#1290](https://github.com/quwisky/trinity-matrix-client/issues/1290)) ([136ba3b](https://github.com/quwisky/trinity-matrix-client/commit/136ba3bed59fc28dd12e3c112bdad0a58e9ebcfc))
* **media:** size thumbnails to the screen's pixel ratio ([#1297](https://github.com/quwisky/trinity-matrix-client/issues/1297)) ([d90066c](https://github.com/quwisky/trinity-matrix-client/commit/d90066c1216ee1fd3a47ab6db2cec22893c5af1d))
* **rooms:** add experimental opt-in for blank rows in fast scrolls ([#1429](https://github.com/quwisky/trinity-matrix-client/issues/1429)) ([8dd5bb8](https://github.com/quwisky/trinity-matrix-client/commit/8dd5bb850867bba1c6ba269a6b0f26e9835e9826))
* **rooms:** add experimental opt-in to load images after fast scrolls ([#1421](https://github.com/quwisky/trinity-matrix-client/issues/1421)) ([d0d9353](https://github.com/quwisky/trinity-matrix-client/commit/d0d93532fe36d5f8e29591456a6b592feb016699))
* **rooms:** build each message row's avatar with less work ([#1424](https://github.com/quwisky/trinity-matrix-client/issues/1424)) ([2703b5b](https://github.com/quwisky/trinity-matrix-client/commit/2703b5b02a5e21de3481e0023e231bb465559bcb))
* **rooms:** keep unchanged room summaries across syncs ([#1307](https://github.com/quwisky/trinity-matrix-client/issues/1307)) ([d159db2](https://github.com/quwisky/trinity-matrix-client/commit/d159db2ed47197c2286e99161ef21785e24d3217))
* **rooms:** window the room sidebar so large accounts keep a small DOM ([#1318](https://github.com/quwisky/trinity-matrix-client/issues/1318)) ([efb794b](https://github.com/quwisky/trinity-matrix-client/commit/efb794b75d19a6b3c5f0dbb3dd44cb750c7656a8))
* **sync:** load room members lazily and in full only for rooms in use ([#1313](https://github.com/quwisky/trinity-matrix-client/issues/1313)) ([67f47e1](https://github.com/quwisky/trinity-matrix-client/commit/67f47e13b3a06a2aae627237678c12b98af8eaa8))
* **timeline:** hold row hover work while the timeline scrolls ([#1301](https://github.com/quwisky/trinity-matrix-client/issues/1301)) ([f4856ff](https://github.com/quwisky/trinity-matrix-client/commit/f4856ff46c803d2cbcefc574d529ea87e991eb67))
* **timeline:** project only the new page when loading older messages ([#1422](https://github.com/quwisky/trinity-matrix-client/issues/1422)) ([d4a4db4](https://github.com/quwisky/trinity-matrix-client/commit/d4a4db40bfbe54823a124d73d5f1fe95ad13af28))

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
