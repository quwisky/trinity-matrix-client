// @trinity/components/emoji-picker — Trinity's emoji surface.
//
// Two exports, because the vendor is reached two ways: the picker ELEMENT (composer panel,
// reaction dialog) and the emoji INDEX (the `:shortcode` autocomplete, which never renders
// a picker). Wrapping only the element would leave three files naming the vendor and the
// lint ban unable to land.
export { TrnEmojiPickerComponent } from './lib/trn-emoji-picker/trn-emoji-picker.component';
export { TrnEmojiIndex } from './lib/trn-emoji-index.service';
export type { TrnEmojiPick, TrnEmojiSuggestion } from './lib/trn-emoji.model';
