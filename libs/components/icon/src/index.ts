// @trinity/components/icon — Trinity's icon, and the only place the app names a vendor icon.
//
// Deliberately in the public tier (`ui:public`) rather than part of `@trinity/ui`: that lib
// is tagged `ui:wrapper` and, since #149, may not import a vendor UI package at all. This one
// may — not through a carve-out for this library, but because the ban is a list of
// `sourceTag`s and `ui:public` is not on it, exactly as `ui:vendor-wrapper` is not. Both are
// wrapper tiers; naming a vendor is their job. `scripts/lint-invariants.spec.mjs` records
// that asymmetry as a table row rather than leaving it to be inferred.
export { TrnIconComponent } from './lib/trn-icon/trn-icon.component';
export { TRN_ICON_NAMES, type TrnIconName } from './lib/trn-icon-name';
export { TRN_ICON_MOTIONS, type TrnIconMotion } from './lib/trn-icon-motion';
export { TRN_ICONS, provideTrnIcons } from './lib/trn-icon.icons';
