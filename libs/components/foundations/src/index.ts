// Domain-neutral design-system foundations. Keep this entrypoint explicit so
// adding a file does not silently expand the public API.
export { TrnIconComponent } from './lib/icon/trn-icon/trn-icon.component';
export { TRN_ICON_NAMES, type TrnIconName } from './lib/icon/trn-icon-name';
export {
  type TrnIconSize,
  type TrnIconVariant,
} from './lib/icon/trn-icon-recipe';
export {
  TRN_ICON_MOTIONS,
  type TrnIconMotion,
} from './lib/icon/trn-icon-motion';
export { TRN_ICONS, provideTrnIcons } from './lib/icon/trn-icon.icons';
export {
  TRN_SIZES,
  TRN_VARIANTS,
  type TrnSize,
  type TrnVariant,
} from './lib/style/trn-recipe-vocabulary';
export { classes, hlm as trn } from '@trinity/helm/utils';
