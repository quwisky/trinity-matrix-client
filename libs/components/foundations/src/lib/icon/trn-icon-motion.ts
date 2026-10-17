/**
 * Small, transform-only gestures an icon may perform with its interactive ancestor.
 *
 * A closed vocabulary on purpose: a motion is added only when a real control needs it, so
 * Storybook and the browser interaction matrix keep covering every supported gesture.
 */
export const TRN_ICON_MOTIONS = [
  'nudge-left',
  'nudge-up',
  'nudge-down',
  'nudge-up-right',
  'pop',
  'rotate',
] as const;

export type TrnIconMotion = (typeof TRN_ICON_MOTIONS)[number];
