# Changelog

All notable changes to this project are documented here. release-please writes each
entry from Conventional Commit subjects when a stable release is cut, and this project
adheres to [Semantic Versioning](https://semver.org/).

## [0.7.0](https://github.com/quwisky/trinity-matrix-client/compare/v0.6.0-next.6...v0.7.0) (2026-11-11)


### Added

* **app-lock:** give the lock screen a card, a clearer heading and calmer recovery steps ([#2041](https://github.com/quwisky/trinity-matrix-client/issues/2041)) ([903e7d5](https://github.com/quwisky/trinity-matrix-client/commit/903e7d52b16625a6fd3e345ef1428b6cb887bfa1))
* **app-lock:** show Trinity's start screen in the app switcher on iOS ([#1940](https://github.com/quwisky/trinity-matrix-client/issues/1940)) ([041b7c4](https://github.com/quwisky/trinity-matrix-client/commit/041b7c4e9d56d856d6707799a56ff9c7d03f85df))
* **appearance:** add a true black option for dark mode ([#1993](https://github.com/quwisky/trinity-matrix-client/issues/1993)) ([de5095d](https://github.com/quwisky/trinity-matrix-client/commit/de5095df9dc5d8da6f1ad90388d5651ea33ea9fe))
* **appearance:** follow iOS Dynamic Type for the device default text size ([#1902](https://github.com/quwisky/trinity-matrix-client/issues/1902)) ([0445227](https://github.com/quwisky/trinity-matrix-client/commit/04452273bb906b024871f4d5ef3e6f3d75a487c2))
* **appearance:** give every text field the composer's look ([#2028](https://github.com/quwisky/trinity-matrix-client/issues/2028)) ([a0bb91f](https://github.com/quwisky/trinity-matrix-client/commit/a0bb91f4b7cdd2211bde3cded6f6cb97f4bb18e8))
* **appearance:** give the sticker search, room header search and select the field look ([#2030](https://github.com/quwisky/trinity-matrix-client/issues/2030)) ([92c5bea](https://github.com/quwisky/trinity-matrix-client/commit/92c5bea3420293c8da30145cdd7b657576cdf591))
* **appearance:** retire the Classic and Midnight themes ([#1994](https://github.com/quwisky/trinity-matrix-client/issues/1994)) ([98e3b0b](https://github.com/quwisky/trinity-matrix-client/commit/98e3b0bddcf1aee677ea62171c09315ab7ad20ca))
* **composer:** add /tableflip, /unflip and /lenny, and apply text art in replies ([#1997](https://github.com/quwisky/trinity-matrix-client/issues/1997)) ([772c1de](https://github.com/quwisky/trinity-matrix-client/commit/772c1de3a261f2734d409597bb123d61d82d99b1))
* **ios:** scroll to the top on a status bar tap and buzz on a message long press ([#1904](https://github.com/quwisky/trinity-matrix-client/issues/1904)) ([5cc5ca0](https://github.com/quwisky/trinity-matrix-client/commit/5cc5ca0a007ac0ac4b2030714217141e5cb8ca6b))
* **mobile:** group the phone action sheet rows into cards ([#1926](https://github.com/quwisky/trinity-matrix-client/issues/1926)) ([8f96485](https://github.com/quwisky/trinity-matrix-client/commit/8f964851a8da425f2b65d2d7a0a9a190db8003dc))
* **mobile:** keep phones in portrait ([#1867](https://github.com/quwisky/trinity-matrix-client/issues/1867)) ([c26108c](https://github.com/quwisky/trinity-matrix-client/commit/c26108cffce3d321fa4a771b5d4eb0161e792b07))
* **mobile:** open room panels as full-screen pages ([#1917](https://github.com/quwisky/trinity-matrix-client/issues/1917)) ([6204470](https://github.com/quwisky/trinity-matrix-client/commit/6204470eda615ff46daa274a981c2e290e06c7b7))
* **notifications:** add an inbox for catching up on mentions ([#1874](https://github.com/quwisky/trinity-matrix-client/issues/1874)) ([7458f9f](https://github.com/quwisky/trinity-matrix-client/commit/7458f9fb04fec8f6cad2489eda95909c00eac458))
* **notifications:** keep mentions on this device for the inbox ([#1878](https://github.com/quwisky/trinity-matrix-client/issues/1878)) ([3b8fdb9](https://github.com/quwisky/trinity-matrix-client/commit/3b8fdb99a7673eb3142e56db6a379bb949d7f99f))
* **notifications:** show closed-app message text for OAuth accounts ([#1857](https://github.com/quwisky/trinity-matrix-client/issues/1857)) ([a21fa30](https://github.com/quwisky/trinity-matrix-client/commit/a21fa30479c17ad7af5ac1bbdd254ae4b54a311e))
* **overlay:** close sheets by dragging their content ([#1900](https://github.com/quwisky/trinity-matrix-client/issues/1900)) ([85912e0](https://github.com/quwisky/trinity-matrix-client/commit/85912e0c47fd89fbf267a0f43669abcae2357c1c))
* **overlay:** give form and alert sheets a centred title, card actions and a Cancel block ([#1955](https://github.com/quwisky/trinity-matrix-client/issues/1955)) ([f3099c3](https://github.com/quwisky/trinity-matrix-client/commit/f3099c32dc3021bf5c3f0929594d9aaeb70006e5))
* **rooms:** float the account bar on phones ([#1869](https://github.com/quwisky/trinity-matrix-client/issues/1869)) ([52cb9bc](https://github.com/quwisky/trinity-matrix-client/commit/52cb9bcde378de5247228c0f355d63bb75b05729))
* **rooms:** give every room side panel one frame and one resizable width ([#2026](https://github.com/quwisky/trinity-matrix-client/issues/2026)) ([ac907a8](https://github.com/quwisky/trinity-matrix-client/commit/ac907a8ba9493630dd0676898ca689ebaf145257))
* **rooms:** give room panels a URL you can reload and share ([#1914](https://github.com/quwisky/trinity-matrix-client/issues/1914)) ([8c78a72](https://github.com/quwisky/trinity-matrix-client/commit/8c78a727a1963d83d1498b1e2d4e010d2bd436b3))
* **rooms:** give the add-to-message, more-unread and accounts sheets the shared card look ([#1958](https://github.com/quwisky/trinity-matrix-client/issues/1958)) ([11e8c7e](https://github.com/quwisky/trinity-matrix-client/commit/11e8c7e86b4e2c5431579429a5302af79e747a3d))
* **rooms:** hold a room to open its actions on touch ([#1898](https://github.com/quwisky/trinity-matrix-client/issues/1898)) ([2938687](https://github.com/quwisky/trinity-matrix-client/commit/2938687259b7742da2e482f2587a4c37c02d4aac))
* **rooms:** open room details from the title and seat short rooms at the bottom on phones ([#1901](https://github.com/quwisky/trinity-matrix-client/issues/1901)) ([c0c01f9](https://github.com/quwisky/trinity-matrix-client/commit/c0c01f91528ca5c074ce87b620871e72f2988c5e))
* **rooms:** share one row, label, empty and loading style across side panels ([#2029](https://github.com/quwisky/trinity-matrix-client/issues/2029)) ([bb947a7](https://github.com/quwisky/trinity-matrix-client/commit/bb947a73535a89554ec6858766de5be99abe6d52))
* **rooms:** show presence, unread threads, pin authors and search filters in side panels ([#2031](https://github.com/quwisky/trinity-matrix-client/issues/2031)) ([bde8f12](https://github.com/quwisky/trinity-matrix-client/commit/bde8f12b035a29ae8e35ab1bd24ef956694b25d7))
* **rooms:** slide between the room list and a room on phones ([#1885](https://github.com/quwisky/trinity-matrix-client/issues/1885)) ([0b41121](https://github.com/quwisky/trinity-matrix-client/commit/0b41121493b12329ad0b569fe27740f015b5c74c))
* **rooms:** view photos edge to edge with tap, zoom and swipe-down gestures ([#1899](https://github.com/quwisky/trinity-matrix-client/issues/1899)) ([58bd617](https://github.com/quwisky/trinity-matrix-client/commit/58bd61749449ca3b1daf6e9aadc9a0b73265f399))
* **settings:** open Settings and System status as half-height sheets you can expand ([#1930](https://github.com/quwisky/trinity-matrix-client/issues/1930)) ([338541c](https://github.com/quwisky/trinity-matrix-client/commit/338541cc225b5b71496123a526c1d18b0531ddf0))
* **settings:** show the settings directory on phones as grouped cards ([#1957](https://github.com/quwisky/trinity-matrix-client/issues/1957)) ([8060449](https://github.com/quwisky/trinity-matrix-client/commit/8060449a975825c41b4b46058fc8fdc1df554e60))
* **settings:** slide Settings sections and swipe them back on phones ([#1921](https://github.com/quwisky/trinity-matrix-client/issues/1921)) ([4a04b59](https://github.com/quwisky/trinity-matrix-client/commit/4a04b5970cf6c394f1a348baf537d7b171dab4ba))
* **settings:** stop keeping a diagnostic log on the device ([#2023](https://github.com/quwisky/trinity-matrix-client/issues/2023)) ([cdf9dd5](https://github.com/quwisky/trinity-matrix-client/commit/cdf9dd59ce21c2730e3217bc67a0475b63cb3e26))
* **startup:** offer Retry startup when startup stalls instead of waiting four minutes ([#1988](https://github.com/quwisky/trinity-matrix-client/issues/1988)) ([00805ab](https://github.com/quwisky/trinity-matrix-client/commit/00805ab67c0481e574160fa767bb31c8359f0111))
* **threads:** show threads in the same list as the room timeline ([#1964](https://github.com/quwisky/trinity-matrix-client/issues/1964)) ([d55619e](https://github.com/quwisky/trinity-matrix-client/commit/d55619e4b28a76faa7d2b7f643ff72e27f4d3332))
* **timeline:** slide new messages in as they arrive ([#1960](https://github.com/quwisky/trinity-matrix-client/issues/1960)) ([81b580b](https://github.com/quwisky/trinity-matrix-client/commit/81b580b54fa845a3c7fb741b4ab5a483836bf970))
* **trust:** show a member's sessions and trust on the profile card ([#1863](https://github.com/quwisky/trinity-matrix-client/issues/1863)) ([72840d5](https://github.com/quwisky/trinity-matrix-client/commit/72840d5f5ceaa6a984dfb08b7ee7b7bba4da6909))


### Fixed

* **a11y:** draw no focus ring on touch devices except text fields ([#1911](https://github.com/quwisky/trinity-matrix-client/issues/1911)) ([309b8c6](https://github.com/quwisky/trinity-matrix-client/commit/309b8c68926844939329d6e421dbe99fa6e4cb96))
* **accounts:** close three account lifecycle gaps ([#2006](https://github.com/quwisky/trinity-matrix-client/issues/2006)) ([827df67](https://github.com/quwisky/trinity-matrix-client/commit/827df67bbc25012fff478c76b1208ab8d027a779))
* **app-lock:** close the QR scanner's camera when the app locks ([#2015](https://github.com/quwisky/trinity-matrix-client/issues/2015)) ([27761f6](https://github.com/quwisky/trinity-matrix-client/commit/27761f6d3558ba44f0238dfe84274cb7b5335a00))
* **app-lock:** stop the privacy cover blacking out the photo picker ([#1938](https://github.com/quwisky/trinity-matrix-client/issues/1938)) ([9296b47](https://github.com/quwisky/trinity-matrix-client/commit/9296b473f1061fd67e0f2507a438e9ad289d285b))
* **appearance:** match the phone's status bar to the bar below it ([#1910](https://github.com/quwisky/trinity-matrix-client/issues/1910)) ([bd1d0b5](https://github.com/quwisky/trinity-matrix-client/commit/bd1d0b5a017602db52ec7562de1a1edf58a4bd3d))
* **auth:** close gaps in the sign-in flows ([#2005](https://github.com/quwisky/trinity-matrix-client/issues/2005)) ([864afbb](https://github.com/quwisky/trinity-matrix-client/commit/864afbb1b1520386fdb1e4bd00f5a8dc206e83c5))
* **auth:** keep encryption keys when a server ends an OAuth session ([#1854](https://github.com/quwisky/trinity-matrix-client/issues/1854)) ([fa5147e](https://github.com/quwisky/trinity-matrix-client/commit/fa5147e0b9a87bb8779a93b6137256dabbd03bd8))
* close two send-retry gaps (offline retry double post, cancelled media resend) ([#2007](https://github.com/quwisky/trinity-matrix-client/issues/2007)) ([27fccb0](https://github.com/quwisky/trinity-matrix-client/commit/27fccb0e92cbbcdd8ea461a0d9319e119cc53761))
* **composer:** attach any file on iOS, not only photos ([#1893](https://github.com/quwisky/trinity-matrix-client/issues/1893)) ([2d5f21a](https://github.com/quwisky/trinity-matrix-client/commit/2d5f21aae311bee7c579bc93547d675bc8fbfaf8))
* **composer:** clear a message sent before its last keystroke was reported, and deflake three tests ([#2016](https://github.com/quwisky/trinity-matrix-client/issues/2016)) ([14a1e79](https://github.com/quwisky/trinity-matrix-client/commit/14a1e791913523b02550ea6f3048bd1eef0c085b))
* **composer:** give the message text more room on phones ([#1892](https://github.com/quwisky/trinity-matrix-client/issues/1892)) ([0756b9c](https://github.com/quwisky/trinity-matrix-client/commit/0756b9cea92ad646247658eac05a2b70e26f8565))
* **composer:** keep a voice message with the account that started recording it ([#2025](https://github.com/quwisky/trinity-matrix-client/issues/2025)) ([a9f4be4](https://github.com/quwisky/trinity-matrix-client/commit/a9f4be4d3d93136c128e410d845e3c64cf068423))
* **composer:** keep sending and failed messages out of the text box ([#2027](https://github.com/quwisky/trinity-matrix-client/issues/2027)) ([c28625e](https://github.com/quwisky/trinity-matrix-client/commit/c28625e9f2348e0abfb72068657685b3df16de64))
* **composer:** keep the newest messages in view as a draft grows ([#1886](https://github.com/quwisky/trinity-matrix-client/issues/1886)) ([d465f03](https://github.com/quwisky/trinity-matrix-client/commit/d465f0379f2c3259d4f6decfff6b3b566c59ff29))
* **composer:** keep undo working after formatting, lists and emoji ([#2011](https://github.com/quwisky/trinity-matrix-client/issues/2011)) ([8040215](https://github.com/quwisky/trinity-matrix-client/commit/8040215d1f59ba8acb9905aabf8b3a1119538bca))
* **composer:** let undo remove an emoji picked from the emoji picker ([#2021](https://github.com/quwisky/trinity-matrix-client/issues/2021)) ([99fc3b3](https://github.com/quwisky/trinity-matrix-client/commit/99fc3b34284e4fce3cc8be10c52fe1b3b2c1023a))
* **composer:** notify and link only the person you picked in a mention ([#2004](https://github.com/quwisky/trinity-matrix-client/issues/2004)) ([18ff536](https://github.com/quwisky/trinity-matrix-client/commit/18ff536649867119a5241463005169f5850ae62f))
* **composer:** scope staged files, GIFs and captions to account and room ([#2001](https://github.com/quwisky/trinity-matrix-client/issues/2001)) ([dc3e771](https://github.com/quwisky/trinity-matrix-client/commit/dc3e7716f56b09ebb85fc0f8d83b286723aca362))
* **composer:** stop a voice recording when the app locks ([#1998](https://github.com/quwisky/trinity-matrix-client/issues/1998)) ([1f2fa23](https://github.com/quwisky/trinity-matrix-client/commit/1f2fa231a61ba9c28f1124ceb8511046a6c854c8))
* **desktop:** open mailto, magnet and ftp links from messages ([#2009](https://github.com/quwisky/trinity-matrix-client/issues/2009)) ([e9d4b01](https://github.com/quwisky/trinity-matrix-client/commit/e9d4b01cc3e84d3ce263888536c8ac614889c0f5))
* **emoji:** fit the reaction and emoji pickers to a phone ([#1996](https://github.com/quwisky/trinity-matrix-client/issues/1996)) ([657e330](https://github.com/quwisky/trinity-matrix-client/commit/657e3307fb13df479d58367ec50bb402d489e2d1))
* **encryption:** share keys with someone whose join the server's state hasn't caught up with ([#1991](https://github.com/quwisky/trinity-matrix-client/issues/1991)) ([129a41e](https://github.com/quwisky/trinity-matrix-client/commit/129a41ee18f6df28287c090f155d27b9a9762300))
* **ios:** move the layout with the keyboard's own timing ([#1913](https://github.com/quwisky/trinity-matrix-client/issues/1913)) ([d79dbd9](https://github.com/quwisky/trinity-matrix-client/commit/d79dbd954fa2a30b58583d0aac7961dad658bc2f))
* make settings and trust state follow the account they belong to ([#2003](https://github.com/quwisky/trinity-matrix-client/issues/2003)) ([a5c0604](https://github.com/quwisky/trinity-matrix-client/commit/a5c06042d9b4b757a361b3649938b2f45c2e82f4))
* **mobile:** keep the keyboard on Send and stop sticky rows ([#1871](https://github.com/quwisky/trinity-matrix-client/issues/1871)) ([c81c0c9](https://github.com/quwisky/trinity-matrix-client/commit/c81c0c9d6b451bfb2f922fb19416019fee78ff8b))
* **mobile:** slide action menus up instead of appearing at once ([#1876](https://github.com/quwisky/trinity-matrix-client/issues/1876)) ([ff93b9a](https://github.com/quwisky/trinity-matrix-client/commit/ff93b9a217456e004836ce7bef92e923765c90ba))
* **mobile:** small polish from the iOS audit ([#1895](https://github.com/quwisky/trinity-matrix-client/issues/1895)) ([b74cb81](https://github.com/quwisky/trinity-matrix-client/commit/b74cb817a7aa0ea9a201e0556e58bce73c5c9848))
* **mobile:** start in one colour with no black or white flash ([#1870](https://github.com/quwisky/trinity-matrix-client/issues/1870)) ([fd3adde](https://github.com/quwisky/trinity-matrix-client/commit/fd3adde405d10ec5d2100aca6820035de13cc79b))
* **navigation:** make browser Back leave a room you hopped to ([#1907](https://github.com/quwisky/trinity-matrix-client/issues/1907)) ([a4c77dc](https://github.com/quwisky/trinity-matrix-client/commit/a4c77dcc7ef4c4b46a53f181d20eb7c7d62788dd))
* **notifications:** claim the iOS token lease by number and end a push's refresh by 13 s ([#1928](https://github.com/quwisky/trinity-matrix-client/issues/1928)) ([92b4056](https://github.com/quwisky/trinity-matrix-client/commit/92b4056f1c9eaa680fc605e4b1dcc60f6cf6c5ef))
* **notifications:** keep inbox hover styles off touch screens ([#1875](https://github.com/quwisky/trinity-matrix-client/issues/1875)) ([fea6cc2](https://github.com/quwisky/trinity-matrix-client/commit/fea6cc26b4fc593fb558b7487f380ada844992d6))
* **notifications:** show room names when the inbox opens before sync ([#1877](https://github.com/quwisky/trinity-matrix-client/issues/1877)) ([200f4c7](https://github.com/quwisky/trinity-matrix-client/commit/200f4c7944a6ace73a0e9b56c03ac879ce8525b4))
* **notifications:** skip old messages when the app reconnects from sleep ([#1862](https://github.com/quwisky/trinity-matrix-client/issues/1862)) ([58bbe87](https://github.com/quwisky/trinity-matrix-client/commit/58bbe8726a343fa6c35ff17db4dbcc33f4cff224))
* **notifications:** stop notifying old messages when the app opens ([#1858](https://github.com/quwisky/trinity-matrix-client/issues/1858)) ([f1146de](https://github.com/quwisky/trinity-matrix-client/commit/f1146defd83c7141ad9cb32b13e406ca12dffd83))
* **overlay:** shrink the empty space at the top of phone sheets ([#1924](https://github.com/quwisky/trinity-matrix-client/issues/1924)) ([9f5eee9](https://github.com/quwisky/trinity-matrix-client/commit/9f5eee90645e2d01617561c4d793a6bd5ecdba7b))
* **push:** hide text of pushes rendered during sign-out ([#2002](https://github.com/quwisky/trinity-matrix-client/issues/2002)) ([af1dbad](https://github.com/quwisky/trinity-matrix-client/commit/af1dbad8b9d2faf9508e6a3c911e6932a108afdc))
* **push:** stop three lease takers stranding the live lease ([#1859](https://github.com/quwisky/trinity-matrix-client/issues/1859)) ([0de764d](https://github.com/quwisky/trinity-matrix-client/commit/0de764d05d83bc41a39803334c4db6282f2d4b5a))
* **rooms:** insert a new line on Enter on phones and tablets ([#2040](https://github.com/quwisky/trinity-matrix-client/issues/2040)) ([581c07c](https://github.com/quwisky/trinity-matrix-client/commit/581c07cc5c9f0b3bf55aa4a1686bce2f325c349a))
* **rooms:** keep a retried message in time order and hold the empty-rooms text until sync ([#1903](https://github.com/quwisky/trinity-matrix-client/issues/1903)) ([6f0175c](https://github.com/quwisky/trinity-matrix-client/commit/6f0175c3323fad38f79148c283dcdb8a12002df4))
* **rooms:** keep late banners from moving the page, and let the encryption prompt be dismissed ([#1894](https://github.com/quwisky/trinity-matrix-client/issues/1894)) ([231f445](https://github.com/quwisky/trinity-matrix-client/commit/231f445c80e102f5cbd5f0d68ad74ac02d73c32a))
* **rooms:** keep the member list marked unavailable until it reloads ([#1983](https://github.com/quwisky/trinity-matrix-client/issues/1983)) ([ed2fffe](https://github.com/quwisky/trinity-matrix-client/commit/ed2fffe626e59953f8aa2d977bc46cc35c47b72c))
* **rooms:** make swipe to reply easier to trigger on phones ([#2034](https://github.com/quwisky/trinity-matrix-client/issues/2034)) ([110d9ae](https://github.com/quwisky/trinity-matrix-client/commit/110d9aec1ce5466a772b2c5b425d0a3bb0d560b6))
* **rooms:** support Synapse room version 12 in room administration ([#1968](https://github.com/quwisky/trinity-matrix-client/issues/1968)) ([bdb04f8](https://github.com/quwisky/trinity-matrix-client/commit/bdb04f808c15c4b659fe49ab092e41507ad9d9b3))
* **session:** answer "Use here" again after a tab declined one ([#2008](https://github.com/quwisky/trinity-matrix-client/issues/2008)) ([21ef43b](https://github.com/quwisky/trinity-matrix-client/commit/21ef43b356e443e942e6430116b6dea4cd2b5bbe))
* **settings:** offer to link a new device from an emoji-verified device ([#2042](https://github.com/quwisky/trinity-matrix-client/issues/2042)) ([a37fc61](https://github.com/quwisky/trinity-matrix-client/commit/a37fc61cddf50ba68d086691897cfde9e16c73bf))
* **startup:** end a retry with no account on the sign-in page ([#1992](https://github.com/quwisky/trinity-matrix-client/issues/1992)) ([153c991](https://github.com/quwisky/trinity-matrix-client/commit/153c99172e00614b6aad8fcba05baf438ffe11bc)), refs [#1989](https://github.com/quwisky/trinity-matrix-client/issues/1989)
* **threads:** keep paging a long thread until it reaches the reply you opened ([#1966](https://github.com/quwisky/trinity-matrix-client/issues/1966)) ([75bc98e](https://github.com/quwisky/trinity-matrix-client/commit/75bc98e34c28603b93fd6655f352887016ac86a4))
* **threads:** keep the newest reply in view as a draft grows ([#1890](https://github.com/quwisky/trinity-matrix-client/issues/1890)) ([86b3039](https://github.com/quwisky/trinity-matrix-client/commit/86b3039473baa6b43fd7a2456329fb692c61f51e))
* **threads:** name the room on the thread page and drop the band under its composer ([#1922](https://github.com/quwisky/trinity-matrix-client/issues/1922)) ([ebe923b](https://github.com/quwisky/trinity-matrix-client/commit/ebe923b07ab30a32cec823a8fa3576d2e0bd4187))
* **timeline:** dismiss the keyboard when the timeline is dragged down ([#1896](https://github.com/quwisky/trinity-matrix-client/issues/1896)) ([1ea73c0](https://github.com/quwisky/trinity-matrix-client/commit/1ea73c01fecd2161ee37b2447c6aac8986fc29e7))
* **timeline:** keep a reader who scrolls up during a history fill in place ([#1934](https://github.com/quwisky/trinity-matrix-client/issues/1934)) ([fb567d1](https://github.com/quwisky/trinity-matrix-client/commit/fb567d1c715b6f04475beca9fca17c08d5760517))
* **timeline:** keep following new messages when the list's own pin reports a scroll ([#1915](https://github.com/quwisky/trinity-matrix-client/issues/1915)) ([856cd86](https://github.com/quwisky/trinity-matrix-client/commit/856cd868525e7278247f20676be4d6a44ee3c55c))
* **timeline:** keep reaction chips pill-shaped on touch ([#1925](https://github.com/quwisky/trinity-matrix-client/issues/1925)) ([93a4c17](https://github.com/quwisky/trinity-matrix-client/commit/93a4c1772f89dbfc3d31b091823dcca24a92d80b))
* **timeline:** keep readers in view and animate them out ([#1891](https://github.com/quwisky/trinity-matrix-client/issues/1891)) ([9bba947](https://github.com/quwisky/trinity-matrix-client/commit/9bba947031d057c4b4ed2f472177153315a0b068))
* **timeline:** keep the long press that opens a sheet from selecting in it ([#1929](https://github.com/quwisky/trinity-matrix-client/issues/1929)) ([edc7af2](https://github.com/quwisky/trinity-matrix-client/commit/edc7af28f55834128770410dcba7ab83b464698f))
* **timeline:** keep the typed text when a thread edit fails ([#1843](https://github.com/quwisky/trinity-matrix-client/issues/1843)) ([cb28610](https://github.com/quwisky/trinity-matrix-client/commit/cb286101866d0a811b9834f93a1d8a97c4eb2097))
* **timeline:** keep your place when older messages load ([#1873](https://github.com/quwisky/trinity-matrix-client/issues/1873)) ([2a17122](https://github.com/quwisky/trinity-matrix-client/commit/2a1712226979de4259a8f2c6f610cebde74da5e8))
* **timeline:** make URLs in formatted messages and replies clickable ([#1944](https://github.com/quwisky/trinity-matrix-client/issues/1944)) ([19ecadd](https://github.com/quwisky/trinity-matrix-client/commit/19ecadd23d3257cdd38b6b353c7effce0aecb0c3))
* **timeline:** reach pinned, searched and dated messages past thread replies ([#2010](https://github.com/quwisky/trinity-matrix-client/issues/2010)) ([4115334](https://github.com/quwisky/trinity-matrix-client/commit/41153342f13d698fcdc0043a6f67a73f47afcfb3))
* **timeline:** show a deleted message in an encrypted room ([#1845](https://github.com/quwisky/trinity-matrix-client/issues/1845)) ([0e5cb0b](https://github.com/quwisky/trinity-matrix-client/commit/0e5cb0b7e5c3450f099355d6d0dd4305d2925be4))
* **timeline:** stop a double-tapped reaction deleting the thread root ([#1832](https://github.com/quwisky/trinity-matrix-client/issues/1832)) ([cc580e0](https://github.com/quwisky/trinity-matrix-client/commit/cc580e03a2244d1df0fac35da92a4686c0e49884))
* **timeline:** stop a late scroll event moving the row under a finger ([#1879](https://github.com/quwisky/trinity-matrix-client/issues/1879)) ([c681226](https://github.com/quwisky/trinity-matrix-client/commit/c6812268e55350ff264b8087d104e22134230789))
* **timeline:** stop a refused room edit showing as saved ([#1849](https://github.com/quwisky/trinity-matrix-client/issues/1849)) ([a832686](https://github.com/quwisky/trinity-matrix-client/commit/a8326869214088059ca92ddc118db3f1a60135c4))
* **timeline:** stop a refused thread edit showing as saved ([#1846](https://github.com/quwisky/trinity-matrix-client/issues/1846)) ([0040ff8](https://github.com/quwisky/trinity-matrix-client/commit/0040ff809614a375fc14f40f7d37bd84d327da6a))
* **timeline:** stop read receipts moving messages ([#1887](https://github.com/quwisky/trinity-matrix-client/issues/1887)) ([c808d01](https://github.com/quwisky/trinity-matrix-client/commit/c808d0141ab1addfe61580277a91bd8498d7a639))
* **tooltip:** stop a tooltip sticking open over the next control after a panel closes ([#1985](https://github.com/quwisky/trinity-matrix-client/issues/1985)) ([01c650a](https://github.com/quwisky/trinity-matrix-client/commit/01c650a860daf96c98a53f14ca3ca8878cdc2fa0))
* **trust:** keep the new recovery key when setup or a reset fails partway ([#1999](https://github.com/quwisky/trinity-matrix-client/issues/1999)) ([d8ecab3](https://github.com/quwisky/trinity-matrix-client/commit/d8ecab334cd21245b983e1580b3397952334cee8))
* **ui:** stop double-tap zoom across the app ([#1927](https://github.com/quwisky/trinity-matrix-client/issues/1927)) ([c61c6d1](https://github.com/quwisky/trinity-matrix-client/commit/c61c6d11f376e9ffcfb92798edf8c19a33580eaf))
* **ui:** stop showing focus rings after a tap or click ([#1872](https://github.com/quwisky/trinity-matrix-client/issues/1872)) ([782c335](https://github.com/quwisky/trinity-matrix-client/commit/782c3356441483de98e466592f7196bdcbdc374f))
* **workspace:** stop room library watcher leaks and Space hierarchy refetches ([#2014](https://github.com/quwisky/trinity-matrix-client/issues/2014)) ([33d07f8](https://github.com/quwisky/trinity-matrix-client/commit/33d07f8797ce804abc583c9a5ed21178d39d9422))


### Changed

* **accounts:** show the active account without waiting for other accounts to restore ([#1956](https://github.com/quwisky/trinity-matrix-client/issues/1956)) ([0f4314f](https://github.com/quwisky/trinity-matrix-client/commit/0f4314fcb7b17a69b1030e00cb30d4383cbc01d3))
* **composer:** cut per-keystroke and per-typing-event scans ([#1973](https://github.com/quwisky/trinity-matrix-client/issues/1973)) ([fb8ea76](https://github.com/quwisky/trinity-matrix-client/commit/fb8ea76a3a1848b520220e0521b6c37ffd91b059))
* **diagnostics:** keep the always-on log at info and add detailed logging ([#1948](https://github.com/quwisky/trinity-matrix-client/issues/1948)) ([c5456a0](https://github.com/quwisky/trinity-matrix-client/commit/c5456a0865bf5d75d750a8321a26f3b74de0d87f))
* **room-list:** rebuild only the rooms a sync changed ([#1980](https://github.com/quwisky/trinity-matrix-client/issues/1980)) ([ac79b66](https://github.com/quwisky/trinity-matrix-client/commit/ac79b664332008e0a000053da767677ce391041e))
* **room-list:** rebuild the room list once after the startup encryption checks ([#1959](https://github.com/quwisky/trinity-matrix-client/issues/1959)) ([11d6b9c](https://github.com/quwisky/trinity-matrix-client/commit/11d6b9c5fa8ce64600f545dabf9367bd26986461))
* **room-list:** reuse unchanged rows in the all-accounts room list ([#1971](https://github.com/quwisky/trinity-matrix-client/issues/1971)) ([6621dca](https://github.com/quwisky/trinity-matrix-client/commit/6621dca0a93188f7b2a764deeb390dae2e96c518))
* **room-list:** stop rebuilding every room, space and invite on each sync ([#2012](https://github.com/quwisky/trinity-matrix-client/issues/2012)) ([0fb89af](https://github.com/quwisky/trinity-matrix-client/commit/0fb89af5c7a3ce03733fde5cd14cade36573c775))
* **room-list:** update the room list once per sync instead of once per room ([#1967](https://github.com/quwisky/trinity-matrix-client/issues/1967)) ([5d980ae](https://github.com/quwisky/trinity-matrix-client/commit/5d980ae0af7c4a434a0bea1b99ea44bee92761f0))
* **rooms:** highlight code blocks in a web worker ([#1943](https://github.com/quwisky/trinity-matrix-client/issues/1943)) ([7718deb](https://github.com/quwisky/trinity-matrix-client/commit/7718deb03151493f3be056ba8a4e1a3c9ab7aa11))
* **rooms:** load each code language on first use and drop Shiki ([#1941](https://github.com/quwisky/trinity-matrix-client/issues/1941)) ([78ecb04](https://github.com/quwisky/trinity-matrix-client/commit/78ecb040a990fc3fb8fcfcec8979a9606ba9ab28))
* **rooms:** load room panels when they first open ([#1969](https://github.com/quwisky/trinity-matrix-client/issues/1969)) ([1bcc0bc](https://github.com/quwisky/trinity-matrix-client/commit/1bcc0bc6a475c6d832b1623fd086ea949c578e9d))
* **spaces:** stop the rail and space badges redrawing on syncs that change nothing ([#1965](https://github.com/quwisky/trinity-matrix-client/issues/1965)) ([4ce019c](https://github.com/quwisky/trinity-matrix-client/commit/4ce019c9539ee3f1bbaa232d5da599554aa9e798))
* **startup:** load the crypto engine and account data in parallel at launch ([#1947](https://github.com/quwisky/trinity-matrix-client/issues/1947)) ([9b45891](https://github.com/quwisky/trinity-matrix-client/commit/9b4589133f51814f33198c45ff7eb019884abd96))
* **startup:** preload lazy routes on idle after the first navigation ([#1975](https://github.com/quwisky/trinity-matrix-client/issues/1975)) ([1e74032](https://github.com/quwisky/trinity-matrix-client/commit/1e7403205be14eb9d456ed745018ca5c2f3a85d5))
* **sync:** load and save the sync cache in a worker ([#1987](https://github.com/quwisky/trinity-matrix-client/issues/1987)) ([e6b2c0a](https://github.com/quwisky/trinity-matrix-client/commit/e6b2c0adf74454d5399867354808bf1c275fe091))
* **sync:** stop syncing in the background on iOS and Android ([#1982](https://github.com/quwisky/trinity-matrix-client/issues/1982)) ([39edd06](https://github.com/quwisky/trinity-matrix-client/commit/39edd060ed2e3e212f6fe42f26fefaf4b49fbb1b)), refs [#1942](https://github.com/quwisky/trinity-matrix-client/issues/1942)
* **timeline:** keep a hidden room's rows until memory is released ([#1970](https://github.com/quwisky/trinity-matrix-client/issues/1970)) ([4852e36](https://github.com/quwisky/trinity-matrix-client/commit/4852e36ccf946e32441cf62429b6c84b65c1006c))
* **timeline:** look up measured rows by index map ([#1974](https://github.com/quwisky/trinity-matrix-client/issues/1974)) ([e3acae5](https://github.com/quwisky/trinity-matrix-client/commit/e3acae5c86a1ca9cc1335e9a217881ba10326f86))
* **timeline:** re-check message shields once per trust change, only for affected senders ([#1979](https://github.com/quwisky/trinity-matrix-client/issues/1979)) ([582cbd1](https://github.com/quwisky/trinity-matrix-client/commit/582cbd1757a2e83b399f31bbd54fa37f0c2bc1d1))
* **timeline:** send at most one read receipt per second while reading ([#1976](https://github.com/quwisky/trinity-matrix-client/issues/1976)) ([d8e2c4e](https://github.com/quwisky/trinity-matrix-client/commit/d8e2c4e3b855f42d4b8e2a879898bcb402d5a0ec))
* **timeline:** skip list updates when a refresh changes no message ([#1945](https://github.com/quwisky/trinity-matrix-client/issues/1945)) ([27e0e72](https://github.com/quwisky/trinity-matrix-client/commit/27e0e72e2c738a563a72d085cdbd12eb4ba8d096))
* **timeline:** stop re-checking every row on each scroll event ([#1946](https://github.com/quwisky/trinity-matrix-client/issues/1946)) ([c3dce1a](https://github.com/quwisky/trinity-matrix-client/commit/c3dce1a0ccb8287ca24a9b7ee59c736cce8094ce))
* **timeline:** trim the open room's history once you're back at the newest messages ([#1990](https://github.com/quwisky/trinity-matrix-client/issues/1990)) ([fc9e675](https://github.com/quwisky/trinity-matrix-client/commit/fc9e67565beb19a76374899c3083cde89f4de754))
* **web:** cache the config editor on first use instead of at install ([#1977](https://github.com/quwisky/trinity-matrix-client/issues/1977)) ([f44b7e6](https://github.com/quwisky/trinity-matrix-client/commit/f44b7e6695d4c8e3185d557f1e67069c2d3310eb))


### Dependencies

* lock file maintenance ([#1842](https://github.com/quwisky/trinity-matrix-client/issues/1842)) ([a7837d6](https://github.com/quwisky/trinity-matrix-client/commit/a7837d68aee43f7c04b6077e1514298e72a4045a))
* lock file maintenance ([#1883](https://github.com/quwisky/trinity-matrix-client/issues/1883)) ([32000bf](https://github.com/quwisky/trinity-matrix-client/commit/32000bf2e240662c1c09f5997ad5b97216f78633))
* update analog to v2.9.5 ([#1936](https://github.com/quwisky/trinity-matrix-client/issues/1936)) ([cf63e92](https://github.com/quwisky/trinity-matrix-client/commit/cf63e9244aa38fb9db2cb843555b4dfb36f153bc))
* update analog to v2.9.6 ([#2017](https://github.com/quwisky/trinity-matrix-client/issues/2017)) ([1f44281](https://github.com/quwisky/trinity-matrix-client/commit/1f44281e9118b92dd6dbfc3e9ae1e1f68e57579d))
* update android gradle plugin and gradle ([#1836](https://github.com/quwisky/trinity-matrix-client/issues/1836)) ([0eec765](https://github.com/quwisky/trinity-matrix-client/commit/0eec765fa48940ac5f160606a85b69217ca5821a))
* update angular to v22.2.5 ([#2043](https://github.com/quwisky/trinity-matrix-client/issues/2043)) ([8db1139](https://github.com/quwisky/trinity-matrix-client/commit/8db1139d8b37ef4dd80e99930ab3d6924818c454))
* update angular to v22.2.6 ([#2018](https://github.com/quwisky/trinity-matrix-client/issues/2018)) ([3f30d84](https://github.com/quwisky/trinity-matrix-client/commit/3f30d84b0196c042e15b9bcd952262e5849f5ca8))
* update angular, astro, eslint, webdriverio and container images ([#1841](https://github.com/quwisky/trinity-matrix-client/issues/1841)) ([ad32209](https://github.com/quwisky/trinity-matrix-client/commit/ad3220983d83952360f2826898276f66a62c9399))
* update astro monorepo ([#2036](https://github.com/quwisky/trinity-matrix-client/issues/2036)) ([4dd5839](https://github.com/quwisky/trinity-matrix-client/commit/4dd5839ea9e27201cbba9a022d1395517750b35b))
* update capacitor to v8.6.0 ([#1840](https://github.com/quwisky/trinity-matrix-client/issues/1840)) ([a35e25d](https://github.com/quwisky/trinity-matrix-client/commit/a35e25d6d1cac9029da5b5b82ba9f08247badbaa))
* update dependency @analogjs/vitest-angular to v2.9.3 ([#1905](https://github.com/quwisky/trinity-matrix-client/issues/1905)) ([6ca70ba](https://github.com/quwisky/trinity-matrix-client/commit/6ca70ba9c953852c285dfb6b77f1deef694c54fb))
* update dependency @astrojs/starlight to v0.42.10 ([#2044](https://github.com/quwisky/trinity-matrix-client/issues/2044)) ([567283f](https://github.com/quwisky/trinity-matrix-client/commit/567283fac997232c490a1615be204994980f2432))
* update dependency @astrojs/starlight to v0.42.9 ([#2019](https://github.com/quwisky/trinity-matrix-client/issues/2019)) ([96a3cc1](https://github.com/quwisky/trinity-matrix-client/commit/96a3cc182e49f9c8c95899f3973a7ca05b5a7b77))
* update dependency @wdio/appium-service to v10.1.1 ([#1949](https://github.com/quwisky/trinity-matrix-client/issues/1949)) ([9f334d7](https://github.com/quwisky/trinity-matrix-client/commit/9f334d733b001aebeddc50b552d8401b52f379b2))
* update dependency astro to v7.4.5 ([#1950](https://github.com/quwisky/trinity-matrix-client/issues/1950)) ([ed8d81b](https://github.com/quwisky/trinity-matrix-client/commit/ed8d81bcb22135b38e0c68ad97db8b94459a5ce6))
* update dependency marked to v18.1.3 ([#1951](https://github.com/quwisky/trinity-matrix-client/issues/1951)) ([f770587](https://github.com/quwisky/trinity-matrix-client/commit/f7705873afd5b4a33335b2490d43c84031eda9ab))
* update dependency ng-mocks to v14.18.5 ([#1937](https://github.com/quwisky/trinity-matrix-client/issues/1937)) ([1424dfd](https://github.com/quwisky/trinity-matrix-client/commit/1424dfdc429626c1c4abe1943932f531dcc25c67))
* update dependency vite to v8.3.6 ([#2037](https://github.com/quwisky/trinity-matrix-client/issues/2037)) ([b2d841c](https://github.com/quwisky/trinity-matrix-client/commit/b2d841c81d1d390acf84bc3255e5af686fc3ce6e))
* update electron shell ([#1837](https://github.com/quwisky/trinity-matrix-client/issues/1837)) ([00c5b59](https://github.com/quwisky/trinity-matrix-client/commit/00c5b59cc20fb6cfb1407924ef1f6b1345db3c28))
* update github actions ([#1835](https://github.com/quwisky/trinity-matrix-client/issues/1835)) ([4aab9a2](https://github.com/quwisky/trinity-matrix-client/commit/4aab9a277cf86bd39431600cb7f172c8d64346bf))
* update matrix-js-sdk to v45 ([#1839](https://github.com/quwisky/trinity-matrix-client/issues/1839)) ([b2de768](https://github.com/quwisky/trinity-matrix-client/commit/b2de768ab2c1f1a383934961e43c64e48cb7abd5))
* update node.js to v26 ([#1882](https://github.com/quwisky/trinity-matrix-client/issues/1882)) ([8f69d1a](https://github.com/quwisky/trinity-matrix-client/commit/8f69d1a5e5374b9b82a9611f33043b14fe15a1e9))
* update nx to v24.0.3 ([#1906](https://github.com/quwisky/trinity-matrix-client/issues/1906)) ([66548e0](https://github.com/quwisky/trinity-matrix-client/commit/66548e04278324d822101750eeaa29e22c312365))
* update nx to v24.0.4 ([#1978](https://github.com/quwisky/trinity-matrix-client/issues/1978)) ([2da8855](https://github.com/quwisky/trinity-matrix-client/commit/2da8855ddcab37f52fcb1a51743b774de2bf9050))
* update nx to v24.0.5 ([#2045](https://github.com/quwisky/trinity-matrix-client/issues/2045)) ([619e976](https://github.com/quwisky/trinity-matrix-client/commit/619e976101ec9763a44947e16143b2db85ce237d))
* update pnpm to v12.16.1 ([#1838](https://github.com/quwisky/trinity-matrix-client/issues/1838)) ([5643b46](https://github.com/quwisky/trinity-matrix-client/commit/5643b46de32576c81a15bab50ec8737f05ded714))
* update postgres image to v18 ([#1880](https://github.com/quwisky/trinity-matrix-client/issues/1880)) ([22aecae](https://github.com/quwisky/trinity-matrix-client/commit/22aecae3e046c28c4bf21a2c12a65fa055fa2b6e))
* update spartan-ng to v1.8.3 ([#1821](https://github.com/quwisky/trinity-matrix-client/issues/1821)) ([1aa217e](https://github.com/quwisky/trinity-matrix-client/commit/1aa217ec4ef10354fc91b559ec01f0ec441da611))
* update spartan-ng to v1.9.0 ([#1881](https://github.com/quwisky/trinity-matrix-client/issues/1881)) ([540aae8](https://github.com/quwisky/trinity-matrix-client/commit/540aae8dc7e846d337b35a36ddff237566fa73eb))
* update storybook monorepo to v10.6.5 ([#1822](https://github.com/quwisky/trinity-matrix-client/issues/1822)) ([4dd8036](https://github.com/quwisky/trinity-matrix-client/commit/4dd8036cbe4a7e48f7e3cf1e0354755782941d99))
* update storybook monorepo to v10.6.6 ([#2038](https://github.com/quwisky/trinity-matrix-client/issues/2038)) ([cb21558](https://github.com/quwisky/trinity-matrix-client/commit/cb21558844d9dc209ddf0e2e0f93cfd009438ad7))
* update tailwind to v4.3.4 ([#1952](https://github.com/quwisky/trinity-matrix-client/issues/1952)) ([8b2c9c7](https://github.com/quwisky/trinity-matrix-client/commit/8b2c9c7aea0708c3a9c4eca8d4a669b5081085a5))
* update tailwind to v4.3.5 ([#2046](https://github.com/quwisky/trinity-matrix-client/issues/2046)) ([188d6d5](https://github.com/quwisky/trinity-matrix-client/commit/188d6d564268b20758e769982fa8a7ab65e3cb3c))
* update the Analog Vite and Vitest plugins to v2.9.4 ([bc65507](https://github.com/quwisky/trinity-matrix-client/commit/bc6550730bafaf1186c910d6b59748a5531cb67a))

## [0.6.0](https://github.com/quwisky/trinity-matrix-client/compare/v0.5.0-next.6...v0.6.0) (2026-10-30)


### Added

* **accounts:** let people find you by your email ([#1712](https://github.com/quwisky/trinity-matrix-client/issues/1712)) ([2fc404a](https://github.com/quwisky/trinity-matrix-client/commit/2fc404a7dbb9acf7325313ab1b3d5c017e3d599d))
* **accounts:** manage email addresses in Settings ([#1707](https://github.com/quwisky/trinity-matrix-client/issues/1707)) ([9bbc7d1](https://github.com/quwisky/trinity-matrix-client/commit/9bbc7d1afaac508bdca5bd38561190fc497a397c))
* **auth:** reset a forgotten password by email ([#1709](https://github.com/quwisky/trinity-matrix-client/issues/1709)) ([e9ae64d](https://github.com/quwisky/trinity-matrix-client/commit/e9ae64d160b5f75334efce5ae428f2781b5d3d0c))
* **media:** personal image pack data for "Your emoji" ([#1656](https://github.com/quwisky/trinity-matrix-client/issues/1656)) ([f190542](https://github.com/quwisky/trinity-matrix-client/commit/f1905428e28745fc7faaaaa4212e578e85f06de5))
* **media:** read, write and edit a room's own image pack ([#1697](https://github.com/quwisky/trinity-matrix-client/issues/1697)) ([26fc826](https://github.com/quwisky/trinity-matrix-client/commit/26fc826242cab1beafec6f08e60721429699e0e9))
* **rooms:** add and send your emoji from messages and the picker ([#1658](https://github.com/quwisky/trinity-matrix-client/issues/1658)) ([ffd7fec](https://github.com/quwisky/trinity-matrix-client/commit/ffd7fec2ed1697f215906efec448e99581c32f04))
* **rooms:** edit a room's emoji in room settings ([#1698](https://github.com/quwisky/trinity-matrix-client/issues/1698)) ([4cb676b](https://github.com/quwisky/trinity-matrix-client/commit/4cb676b6b0749a11c4bfea33d495fd30ee88fb57))
* **rooms:** edit what each role may do in rooms and spaces ([#1720](https://github.com/quwisky/trinity-matrix-client/issues/1720)) ([d73626a](https://github.com/quwisky/trinity-matrix-client/commit/d73626a0d1d66c5f63c154f4f40ef40b574c9dba))
* **rooms:** let admins approve requests to join and revoke invites ([#1725](https://github.com/quwisky/trinity-matrix-client/issues/1725)) ([47e4dcb](https://github.com/quwisky/trinity-matrix-client/commit/47e4dcb8aaf75572e3f01f0f5e5fb45d4a910aad))
* **rooms:** let you respond when someone in a room changes identity ([#1724](https://github.com/quwisky/trinity-matrix-client/issues/1724)) ([538af71](https://github.com/quwisky/trinity-matrix-client/commit/538af71028a6616921faa691cc49491bc9e507b0))
* **rooms:** say whether someone you invite can read a room's earlier messages ([#1723](https://github.com/quwisky/trinity-matrix-client/issues/1723)) ([99eaf13](https://github.com/quwisky/trinity-matrix-client/commit/99eaf13ccd2ca8a59cc2ce56c1e3819a4b0039f4))
* **settings:** manage your emoji in Settings ([#1657](https://github.com/quwisky/trinity-matrix-client/issues/1657)) ([167b11c](https://github.com/quwisky/trinity-matrix-client/commit/167b11cecd55b66d4d46ab4b1ddb4cfa59784146))
* **storage:** warn before the device runs out of space for Trinity's data ([#1734](https://github.com/quwisky/trinity-matrix-client/issues/1734)) ([42c4c58](https://github.com/quwisky/trinity-matrix-client/commit/42c4c589f7fa57f8cf3fabbd0de19a30f07ea8b2))
* **timeline:** send messages written offline once the connection returns ([#1695](https://github.com/quwisky/trinity-matrix-client/issues/1695)) ([fe0d238](https://github.com/quwisky/trinity-matrix-client/commit/fe0d238ea278d821d3964267bfe3e117fb53360c))


### Fixed

* **auth:** don't fail sign-in when MAS registers the app twice at once, and fix the QR flakes on MAS ([#1718](https://github.com/quwisky/trinity-matrix-client/issues/1718)) ([d13d798](https://github.com/quwisky/trinity-matrix-client/commit/d13d7988fd57cd6b02a2dd2ffed33255dcbf7905))
* **container:** check static caching by rule instead of a file list ([#1651](https://github.com/quwisky/trinity-matrix-client/issues/1651)) ([261bb3d](https://github.com/quwisky/trinity-matrix-client/commit/261bb3dfda359df1ae4e2d7b3f6a21d699c0f0c6))
* **crypto:** share keys that are only in backup when inviting to a room ([#1733](https://github.com/quwisky/trinity-matrix-client/issues/1733)) ([7ef8b12](https://github.com/quwisky/trinity-matrix-client/commit/7ef8b12001d5346a8e435f5382bcb8b4b9c6cf29))
* **deps:** update electron to 44.9.3 and require node 24.22.1 ([#1687](https://github.com/quwisky/trinity-matrix-client/issues/1687)) ([26f7ff9](https://github.com/quwisky/trinity-matrix-client/commit/26f7ff9030e28719693aa2996fef1e959054801c))
* **deps:** update electron to 45.0.0 ([#1688](https://github.com/quwisky/trinity-matrix-client/issues/1688)) ([2892959](https://github.com/quwisky/trinity-matrix-client/commit/28929599f03dc77394e6ef82a2c36f2664845a80))
* **platform-native:** follow the iOS keyboard when the app shrinks ([#1662](https://github.com/quwisky/trinity-matrix-client/issues/1662)) ([b723fbf](https://github.com/quwisky/trinity-matrix-client/commit/b723fbf742df361e6c313e2bf564b779eba0f3f2))
* **rooms:** inset side-panel headers only as phone drawers ([2c772d2](https://github.com/quwisky/trinity-matrix-client/commit/2c772d214575187b5a7fedb526bdd58991f9f541))
* **rooms:** keep the phone keyboard down when the emoji picker opens ([#1660](https://github.com/quwisky/trinity-matrix-client/issues/1660)) ([7e87e6b](https://github.com/quwisky/trinity-matrix-client/commit/7e87e6ba8b2a9fd6e0d74d6d55bf2c63cd5ce442))
* **rooms:** let the phone drawers own their status-bar inset ([c7e7903](https://github.com/quwisky/trinity-matrix-client/commit/c7e7903fe640bf0c1b4fb2dba3501537c90ea0fb))
* **rooms:** mark a merged room's preview by the account that encrypts it ([#1678](https://github.com/quwisky/trinity-matrix-client/issues/1678)) ([2d7da7d](https://github.com/quwisky/trinity-matrix-client/commit/2d7da7d3bb42771de13326342b0fc09055e68807))
* **rooms:** show a shared room as the active account sees it ([#1680](https://github.com/quwisky/trinity-matrix-client/issues/1680)) ([7ba5c58](https://github.com/quwisky/trinity-matrix-client/commit/7ba5c58664d7d51757e8ee9e71849bda247037f9)), refs [#1679](https://github.com/quwisky/trinity-matrix-client/issues/1679)
* **rooms:** show unencrypted messages' text in the room list preview ([#1670](https://github.com/quwisky/trinity-matrix-client/issues/1670)) ([973b426](https://github.com/quwisky/trinity-matrix-client/commit/973b426b0a8d82aef325835460d62c19dc431c46))
* **rooms:** show unencrypted reply quotes' text with the mark ([#1676](https://github.com/quwisky/trinity-matrix-client/issues/1676)) ([cad3956](https://github.com/quwisky/trinity-matrix-client/commit/cad395699ee78c431f2ee29a97b3d025fbdbeba3))
* **storage:** stop warning about protected storage on iOS ([#1730](https://github.com/quwisky/trinity-matrix-client/issues/1730)) ([4451b65](https://github.com/quwisky/trinity-matrix-client/commit/4451b657b7bb511504f95a54263ab221e8b0b550))
* **ui:** keep the status banner below the iOS status bar ([c290f35](https://github.com/quwisky/trinity-matrix-client/commit/c290f357306ac8461be3bf39871308cfc1abf239))
* **ui:** let Escape reach a dialog while a dropdown inside it is closing ([#1729](https://github.com/quwisky/trinity-matrix-client/issues/1729)) ([8383da0](https://github.com/quwisky/trinity-matrix-client/commit/8383da0f8a01945be08a094ba736dbe6ba9146e6)), refs [#1726](https://github.com/quwisky/trinity-matrix-client/issues/1726)
* **ui:** stop routed page headers padding the iOS status bar twice ([95fdaaa](https://github.com/quwisky/trinity-matrix-client/commit/95fdaaa9590b0ad0663e5e6dc95322743a8def2d))


### Dependencies

* update angular ([#1699](https://github.com/quwisky/trinity-matrix-client/issues/1699)) ([9e4bdac](https://github.com/quwisky/trinity-matrix-client/commit/9e4bdac147e64abf59b55a3055b2ebcf4e43c968))
* update angular ([#1714](https://github.com/quwisky/trinity-matrix-client/issues/1714)) ([8fea4f5](https://github.com/quwisky/trinity-matrix-client/commit/8fea4f5b5d593a111d7f7278329330c484b17473))
* update astro monorepo ([#1704](https://github.com/quwisky/trinity-matrix-client/issues/1704)) ([d9721b6](https://github.com/quwisky/trinity-matrix-client/commit/d9721b6d09964a7cb5c545a843d56120e1f547cc))
* update dependency @astrojs/starlight to v0.42.7 ([#1736](https://github.com/quwisky/trinity-matrix-client/issues/1736)) ([4c5f868](https://github.com/quwisky/trinity-matrix-client/commit/4c5f868ea7c4db63b2239bb57300b329158d606c))
* update dependency @lezer/common to v1.5.4 ([#1715](https://github.com/quwisky/trinity-matrix-client/issues/1715)) ([1be30b5](https://github.com/quwisky/trinity-matrix-client/commit/1be30b5914b32e322b9b161a555f356fdde4b3cd))
* update dependency katex to v0.19.1 ([#1737](https://github.com/quwisky/trinity-matrix-client/issues/1737)) ([c2f221f](https://github.com/quwisky/trinity-matrix-client/commit/c2f221f87ff52ab9ff948118789ea34f18dd13b3))
* update dependency marked to v18.1.2 ([#1796](https://github.com/quwisky/trinity-matrix-client/issues/1796)) ([9727a32](https://github.com/quwisky/trinity-matrix-client/commit/9727a32e9ebee301012c4ef2b02244b3a63f15d1))
* update dependency ng-packagr to v22.2.5 ([#1738](https://github.com/quwisky/trinity-matrix-client/issues/1738)) ([3bee4e4](https://github.com/quwisky/trinity-matrix-client/commit/3bee4e4a06b603e40eef1ee2406777425c57c22d))
* update dependency postcss to v8.5.32 ([#1797](https://github.com/quwisky/trinity-matrix-client/issues/1797)) ([ecb704b](https://github.com/quwisky/trinity-matrix-client/commit/ecb704b5f1d72fcfd27966deebb2346f052cf211))
* update dependency vite to v8.3.5 ([#1705](https://github.com/quwisky/trinity-matrix-client/issues/1705)) ([d554f23](https://github.com/quwisky/trinity-matrix-client/commit/d554f23c4adf82733c73db8dd8accaa8b80add8f))
* update dependency vitest to v5.0.5 ([#1700](https://github.com/quwisky/trinity-matrix-client/issues/1700)) ([257734b](https://github.com/quwisky/trinity-matrix-client/commit/257734b0c8011903873bfffbcf9bcb89a189949c))
* update nx to 24.0.1 ([#1732](https://github.com/quwisky/trinity-matrix-client/issues/1732)) ([e2fcd9b](https://github.com/quwisky/trinity-matrix-client/commit/e2fcd9b99f6273d0b7ab5f2dd4e88355000b0c3f))
* update nx to v24.0.2 ([#1798](https://github.com/quwisky/trinity-matrix-client/issues/1798)) ([5e84b37](https://github.com/quwisky/trinity-matrix-client/commit/5e84b379614e5c7e2d5e59048ae922cb16571267))
* update spartan-ng to 1.8.2 ([#1731](https://github.com/quwisky/trinity-matrix-client/issues/1731)) ([5648938](https://github.com/quwisky/trinity-matrix-client/commit/56489381b6df1b5833d3395e1233f12cd81786e4))
* update storybook monorepo to v10.6.3 ([#1701](https://github.com/quwisky/trinity-matrix-client/issues/1701)) ([cd403ab](https://github.com/quwisky/trinity-matrix-client/commit/cd403ab5c455308358ccb97575806d71cc97ba4a))
* update storybook monorepo to v10.6.4 ([#1799](https://github.com/quwisky/trinity-matrix-client/issues/1799)) ([71bf13c](https://github.com/quwisky/trinity-matrix-client/commit/71bf13c11e7a70608d6995bb42926afec44bb989))

## [0.5.2](https://github.com/quwisky/trinity-matrix-client/compare/v0.5.1...v0.5.2) (2026-10-23)


### Fixed

* **deps:** update electron to 44.9.3 and require node 24.22.1 ([#1687](https://github.com/quwisky/trinity-matrix-client/issues/1687)) ([#1690](https://github.com/quwisky/trinity-matrix-client/issues/1690)) ([6d845c6](https://github.com/quwisky/trinity-matrix-client/commit/6d845c6ef33479a97c64568fbbe39c6793cbbb97))

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
