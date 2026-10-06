// A real-behaving `@Audit()` stand-in for controller specs: records the key,
// the params and the English the interceptor would store, so a spec can
// assert on whichever it cares about.
import type { AuditDetailWithOutcome } from '../audit-detail';
import {
  renderAuditDetail,
  type AuditDetailKey,
  type AuditDetailParams,
} from '../audit-detail-catalog';

export interface RecordedAuditDetail {
  key: AuditDetailKey;
  params: Readonly<Record<string, string | number>>;
  english: string;
  failed: boolean;
}

export function recordingAudit(): AuditDetailWithOutcome & {
  recorded: RecordedAuditDetail[];
  /** The English of every description, in call order. */
  described: string[];
} {
  const recorded: RecordedAuditDetail[] = [];
  const push = <K extends AuditDetailKey>(
    key: K,
    params: AuditDetailParams<K>,
    failed: boolean,
  ): void => {
    recorded.push({
      key,
      params: { ...params },
      english: renderAuditDetail(key, params),
      failed,
    });
  };
  return {
    recorded,
    get described() {
      return recorded.map((entry) => entry.english);
    },
    describe: (key, params) => push(key, params, false),
    fail: (key, params) => push(key, params, true),
  };
}
