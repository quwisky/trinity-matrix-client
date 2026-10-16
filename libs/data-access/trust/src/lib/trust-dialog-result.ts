/**
 * What a trust dialog closes with to ask its opener for the next step. Trust cannot open
 * Settings itself (the capability does not depend on Workspace), so the dialog names the
 * intent and the application presenter decides where it lives.
 *
 * `manage-identity`: the user cannot verify this device and wants the identity choices,
 * including the confirmed reset, which live in Security settings.
 */
export type TrustDialogResult = { readonly kind: 'manage-identity' };

/** The verify dialog's way on for someone without the device that holds the identity. */
export const MANAGE_IDENTITY: TrustDialogResult = { kind: 'manage-identity' };

/** Whether a dialog close value is a {@link TrustDialogResult}. */
export function isTrustDialogResult(
  value: unknown,
): value is TrustDialogResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'manage-identity'
  );
}
