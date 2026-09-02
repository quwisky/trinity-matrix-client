/**
 * Exact fingerprints of every authored production ruleset that Angular still emits
 * outside Trinity's named cascade layers.
 *
 * The source inventories live in styling-idiom.spec.mjs; this is deliberately stricter.
 * Fingerprints use comment-free, whitespace-normalized CSS, so adding or changing a rule
 * inside an existing source fails just as a new source does. Entries may only disappear as
 * components migrate into a named layer.
 */
export const UNLAYERED_RULESET_LEDGER = [
  [
    'libs/components/controls/src/lib/checkbox/trn-checkbox.component.ts#inline-styles',
    'a026ec4832cea8bee39ce42f0ce8d47c75657098303b1195b942f09ffeb459db',
  ],
  [
    'libs/components/controls/src/lib/radio-group/trn-radio-group.component.ts#inline-styles',
    'c483ff224f1484acb700866912871b7e5c89b6f8fd751c798859cf5ef8b16b4a',
  ],
  [
    'libs/components/controls/src/lib/switch/trn-switch.component.ts#inline-styles',
    'a026ec4832cea8bee39ce42f0ce8d47c75657098303b1195b942f09ffeb459db',
  ],
];
