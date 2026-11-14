/** Anchored so checksums, `.blockmap`, `latest*.yml` and `site-screenshots.zip` never match. */
const PATTERNS = {
  macDmg: /-arm64\.dmg$/,
  macZip: /-arm64-mac\.zip$/,
  windows: /^Trinity\.Setup\..+\.exe$/,
  linuxAppImage: /\.AppImage$/,
  linuxDeb: /_amd64\.deb$/,
  web: /^Trinity-Web-.+\.zip$/,
};

/**
 * Direct asset link per platform; a platform without a matching asset links to the release page.
 * @param {{ tag_name: string | null; html_url: string; assets: { name: string; browser_download_url: string }[] }} release
 * @returns {{ macDmg: string; macZip: string; windows: string; linuxAppImage: string; linuxDeb: string; web: string; version: string | null }}
 */
export function resolveDownloads(release) {
  const link = (pattern) =>
    release.assets.find(({ name }) => pattern.test(name))
      ?.browser_download_url ?? release.html_url;
  return {
    macDmg: link(PATTERNS.macDmg),
    macZip: link(PATTERNS.macZip),
    windows: link(PATTERNS.windows),
    linuxAppImage: link(PATTERNS.linuxAppImage),
    linuxDeb: link(PATTERNS.linuxDeb),
    web: link(PATTERNS.web),
    version: release.tag_name?.replace(/^v/, '') ?? null,
  };
}
