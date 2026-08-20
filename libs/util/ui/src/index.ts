// @trinity/util/ui — the view-layer helpers that are not components.
//
// These lived in `@trinity/ui` while that library was also five presentational components.
// Once the components moved to the public tier, what was left was a `util/` folder inside a
// `type:ui` library — helpers with no template, no selector and nothing presentational about
// them, sitting in the one tier that may not be depended on by `type:data-access` or
// `type:platform`. Here they are `type:util`, which every layer may reach.
//
// The layer's contract is "no Angular DI", and it still holds: `runWithBusy` and
// `mediaQuerySignal` both TAKE a `DestroyRef` rather than injecting one, so nothing here
// needs an injection context and nothing here can throw NG0203.
export * from './lib/with-busy';
export * from './lib/media-query';
export * from './lib/reduced-motion';
export * from './lib/internal-url';
