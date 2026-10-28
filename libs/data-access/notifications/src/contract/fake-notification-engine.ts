import {
  type Observable,
  Subject,
  defer,
  distinctUntilChanged,
  map,
  of,
  startWith,
} from 'rxjs';
import {
  type EngineFailure,
  type EngineResult,
  engineFail,
  engineOk,
  plainEqual,
} from '@trinity/util/matrix';
import type {
  DefaultPushRule,
  KeywordRule,
  NotificationEngine,
  NotificationSettings,
  PushRuleKind,
} from '../lib/notification-engine';

interface FakeKeywordRule {
  readonly ruleId: string;
  readonly pattern: string;
  enabled: boolean;
  actions: unknown[];
}

const KEYWORD_ACTIONS = [
  'notify',
  { set_tweak: 'sound', value: 'default' },
  { set_tweak: 'highlight' },
];

const NOT_LIVE: EngineFailure = {
  kind: 'unexpected',
  code: 'account-not-live',
  diagnostic: { kind: 'unexpected' },
};

const NOT_FOUND: EngineFailure = {
  kind: 'http',
  code: 'request-failed',
  diagnostic: { kind: 'http', httpStatus: 404, errcode: 'M_NOT_FOUND' },
};

const UNLOADED: NotificationSettings = {
  loaded: false,
  defaultRules: [],
  keywords: [],
};

/** An in-memory {@link NotificationEngine} with one live account, {@link alice}. */
export class FakeNotificationEngine implements NotificationEngine {
  private readonly defaults: DefaultPushRule[] = [
    { ruleId: '.m.rule.master', kind: 'override', enabled: false },
    { ruleId: '.m.rule.invite_for_me', kind: 'override', enabled: true },
    { ruleId: '.m.rule.is_user_mention', kind: 'override', enabled: true },
    { ruleId: '.m.rule.contains_user_name', kind: 'content', enabled: true },
    { ruleId: '.m.rule.message', kind: 'underride', enabled: true },
  ];
  /** Server order: a rule written without `before`/`after` goes first. */
  private keywordRules: FakeKeywordRule[] = [];
  private readonly changes = new Subject<void>();

  readonly alice = '@alice:fake';

  /**
   * Another client PUTs the content rule `ruleId`, then switches it off unless `enabled`, as a
   * sync would deliver it. Like Synapse, a PUT over an existing rule keeps its enabled flag.
   */
  writeKeywordRule(
    ruleId: string,
    pattern: string,
    enabled = true,
    actions: unknown[] = ['notify'],
  ): void {
    const kept =
      this.keywordRules.find((rule) => rule.ruleId === ruleId)?.enabled ?? true;
    this.keywordRules = [
      { ruleId, pattern, enabled: kept && enabled, actions },
      ...this.keywordRules.filter((rule) => rule.ruleId !== ruleId),
    ];
    this.changes.next();
  }

  /** Replaces the server-defined rules, as a homeserver variant ships them. */
  defineDefaultRules(rules: readonly DefaultPushRule[]): void {
    this.defaults.splice(0, this.defaults.length, ...rules);
    this.changes.next();
  }

  /** The stored actions of content rule `ruleId`, as the server holds them. */
  keywordActions(ruleId: string): unknown {
    const rule = this.keywordRules.find((entry) => entry.ruleId === ruleId);
    return rule ? structuredClone(rule.actions) : undefined;
  }

  settings(accountId: string): Observable<NotificationSettings> {
    return this.changes.pipe(
      startWith(undefined),
      map(() => (accountId === this.alice ? this.snapshot() : UNLOADED)),
      distinctUntilChanged<NotificationSettings>(plainEqual),
    );
  }

  setPushRulesEnabled(
    accountId: string,
    rules: readonly { readonly ruleId: string; readonly kind: PushRuleKind }[],
    enabled: boolean,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, () => {
      const targets = rules.map((target) =>
        this.defaults.findIndex(
          (rule) => rule.ruleId === target.ruleId && rule.kind === target.kind,
        ),
      );
      if (targets.includes(-1)) return engineFail(NOT_FOUND);
      for (const index of targets) {
        this.defaults[index] = { ...this.defaults[index], enabled };
      }
      this.changes.next();
      return engineOk(null);
    });
  }

  setKeyword(
    accountId: string,
    pattern: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, () => {
      const existing = this.keywordRules.filter(
        (rule) => rule.pattern === pattern,
      );
      if (existing.length === 0) {
        this.writeKeywordRule(pattern, pattern, true, KEYWORD_ACTIONS);
        const written = this.keywordRules[0];
        if (!written.enabled) {
          written.enabled = true;
          this.changes.next();
        }
      } else if (!existing.some((rule) => rule.enabled)) {
        existing[0].enabled = true;
        existing[0].actions = KEYWORD_ACTIONS;
        this.changes.next();
      }
      return engineOk(null);
    });
  }

  removeKeyword(
    accountId: string,
    pattern: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, () => {
      this.keywordRules = this.keywordRules.filter(
        (rule) => rule.pattern !== pattern,
      );
      this.changes.next();
      return engineOk(null);
    });
  }

  private snapshot(): NotificationSettings {
    const keywords = new Map<string, boolean>();
    for (const rule of this.keywordRules) {
      keywords.set(rule.pattern, !!keywords.get(rule.pattern) || rule.enabled);
    }
    return {
      loaded: true,
      defaultRules: this.defaults.map((rule) => ({ ...rule })),
      keywords: [...keywords].map(([pattern, enabled]): KeywordRule => ({
        pattern,
        enabled,
      })),
    };
  }

  private command(
    accountId: string,
    run: () => EngineResult<null>,
  ): Observable<EngineResult<null>> {
    return defer(() =>
      of(accountId === this.alice ? run() : engineFail(NOT_LIVE)),
    );
  }
}
