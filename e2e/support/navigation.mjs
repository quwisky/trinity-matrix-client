/** Wait for Application Runtime's stable, Account-qualified Rooms destination. */
export async function waitForRooms(page, timeout = 30_000) {
  await page.waitForURL(
    (url) =>
      url.pathname === '/rooms' &&
      (url.searchParams.get('account')?.length ?? 0) > 0,
    { timeout },
  );
}
