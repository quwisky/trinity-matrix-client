import type { DiagnosticReportFacts } from './diagnostic-bundle';

/** Stay well inside what GitHub and browsers accept for one URL. */
export const GITHUB_ISSUE_URL_LIMIT = 8000;

const GITHUB_REPOSITORY =
  /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;
const TRIMMED = ' […]';

export interface BugReportDraft {
  /** The user's "What went wrong?" text, possibly empty. */
  readonly description: string;
  readonly facts: DiagnosticReportFacts;
  /** The saved log's name, or null when the user left logs out. */
  readonly logFileName: string | null;
}

/**
 * The repository's `bug_report.yml` form, pre-filled by field id
 * (`.github/ISSUE_TEMPLATE/bug_report.yml`). The dropdowns are left for the user. The
 * description is trimmed, on a character boundary, until the URL fits `limit`. Returns null
 * for anything that is not a GitHub repository URL.
 */
export function buildBugReportUrl(
  repositoryUrl: string,
  draft: BugReportDraft,
  limit = GITHUB_ISSUE_URL_LIMIT,
): string | null {
  const match = GITHUB_REPOSITORY.exec(repositoryUrl.trim());
  if (!match) {
    return null;
  }
  const base = `https://github.com/${match[1]}/${match[2]}/issues/new`;
  const build = (summary: string): string => {
    const params = new URLSearchParams({ template: 'bug_report.yml' });
    if (summary) params.set('summary', summary);
    if (draft.facts.version) params.set('version', draft.facts.version);
    if (draft.facts.platform) params.set('os', draft.facts.platform);
    if (draft.facts.homeservers.length > 0) {
      params.set('homeserver', draft.facts.homeservers.join('; '));
    }
    if (draft.logFileName) {
      // The template renders this field as a shell code block, so it names the file and
      // points at a field where an attachment renders.
      params.set(
        'logs',
        `Diagnostic log: ${draft.logFileName}. Attach the saved file in "Other observations" below; this box is shown as code.`,
      );
    }
    return `${base}?${params.toString()}`;
  };

  const characters = Array.from(draft.description.trim());
  const full = build(characters.join(''));
  if (full.length <= limit) {
    return full;
  }
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (build(characters.slice(0, middle).join('') + TRIMMED).length <= limit) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const trimmed = build(
    low > 0 ? characters.slice(0, low).join('') + TRIMMED : '',
  );
  return trimmed.length <= limit ? trimmed : null;
}
