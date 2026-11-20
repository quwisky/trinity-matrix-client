let nextTitleId = 0;

/** A document-unique id for a dialog's title heading. */
export function dialogTitleId(): string {
  return `trn-dialog-title-${nextTitleId++}`;
}
