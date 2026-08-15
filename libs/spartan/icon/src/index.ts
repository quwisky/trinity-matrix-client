// @trinity/helm/icon — Trinity's icon, and the only place the app names a vendor icon.
//
// Deliberately a kit library (`ui:vendor-wrapper`) rather than part of `@trinity/ui`:
// that lib is tagged `ui:wrapper` and, since #149, may not import a vendor UI package at
// all. This one may — not through a carve-out for this library, but because the ban is a
// list of `sourceTag`s and `ui:vendor-wrapper` is simply not on it. Five sibling kit
// libraries import `@ng-icons` on the same footing.
export { TrnIconComponent } from './lib/trn-icon/trn-icon.component';
export { TRN_ICON_NAMES, type TrnIconName } from './lib/trn-icon-name';
export { TRN_ICONS, provideTrnIcons } from './lib/trn-icon.icons';
