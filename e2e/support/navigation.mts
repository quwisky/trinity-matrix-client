import type { Navigate } from './platform-contracts.mts';

export const navigateApplication: Navigate = async (page, path) => {
  await page.goto(path, { waitUntil: 'networkidle' });
};
