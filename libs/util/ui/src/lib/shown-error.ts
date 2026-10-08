/**
 * The error a form control should display: its first one, once the reader has touched it.
 * Templates bind it with `@let` so the invalid state, the described-by id and the message
 * all read one value.
 */
export function shownError<E extends { readonly message?: string }>(
  field: () => {
    touched(): boolean;
    errors(): readonly E[];
  },
): E | undefined {
  const state = field();
  return state.touched() ? state.errors()[0] : undefined;
}
