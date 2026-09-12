import { z } from 'astro/zod';

export const PAGE_TYPES = [
  'tutorial',
  'how-to',
  'explanation',
  'reference',
] as const;

export const PLATFORMS = ['web', 'desktop', 'android', 'ios'] as const;

type ReleaseManifest =
  | { status: 'unreleased'; version: null }
  | { status: 'published'; version: string };

const commonPageFields = {
  description: z.string().trim().min(1),
  pageType: z.enum(PAGE_TYPES),
  platforms: z.array(z.enum(PLATFORMS)).min(1),
};

export function publicPageSchema(
  audience: 'user',
  release: ReleaseManifest,
): z.ZodObject<z.ZodRawShape>;
export function publicPageSchema(
  audience: 'developer',
): z.ZodObject<z.ZodRawShape>;
export function publicPageSchema(
  audience: 'user' | 'developer',
  release?: ReleaseManifest,
) {
  if (audience === 'developer') {
    return z.object({
      ...commonPageFields,
      audience: z.literal('developer'),
      contentChannel: z.literal('develop'),
      productVersion: z.never().optional(),
    });
  }

  if (!release) {
    throw new Error('User page schemas require a release manifest.');
  }

  return z.object({
    ...commonPageFields,
    audience: z.literal('user'),
    contentChannel: z.literal('release'),
    productVersion:
      release.status === 'published'
        ? z.literal(release.version)
        : z.never().optional(),
  });
}
