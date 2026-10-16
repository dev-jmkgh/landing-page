import { execute } from '../../db/pool';
import { describeError, logger } from '../../utils/logger';
import type { HrActor } from './hrAuth.service';

/**
 * Audit entries for actions taken INSIDE the HR app — a team manager approving leave on
 * their phone.
 *
 * Administrator actions keep using `recordAudit` from the telecalling activity module,
 * which labels the admin portal's actor. That function needs a telecalling `Actor`, and
 * an HR account is not one: passing an hr_users id through it would file the entry
 * under whichever telecaller happens to share the number. So HR-app actions are written
 * here, into the same `audit_logs` table — one trail for "who approved this?" — with
 * the actor labelled as an HR account so the two id spaces can never be confused.
 *
 * `actor_type` is 'employee' (the table's enum has no HR value) and the label always
 * starts `HR app:`; the HR audit viewer reads that prefix.
 */
export const HR_APP_ACTOR_PREFIX = 'HR app:';

export async function recordHrAppAudit(input: {
  actor: HrActor & { employeeCode?: string };
  action: string;
  entityType: string;
  entityId?: number | null;
  summary: string;
  meta?: Record<string, unknown> | null;
  ipAddress?: string | null;
}): Promise<void> {
  const label = `${HR_APP_ACTOR_PREFIX} ${input.actor.name}${
    input.actor.employeeCode ? ` (${input.actor.employeeCode})` : ''
  }`.slice(0, 190);

  await execute(
    `INSERT INTO audit_logs
       (actor_type, actor_id, actor_label, action, entity_type, entity_id, summary, meta, ip_address)
     VALUES ('employee', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.actor.id,
      label,
      input.action,
      input.entityType,
      input.entityId ?? null,
      input.summary.slice(0, 255),
      JSON.stringify({ ...(input.meta ?? {}), hrUserId: input.actor.id }),
      input.ipAddress ?? null,
    ],
  ).catch((error) =>
    logger.error('Could not write HR app audit log', {
      action: input.action,
      ...describeError(error),
    }),
  );
}
