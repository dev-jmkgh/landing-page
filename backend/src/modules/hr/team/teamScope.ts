import { queryOne, type RowDataPacket } from '../../../db/pool';
import type { HrActor } from '../hrAuth.service';

/**
 * Who is on a team manager's team.
 *
 * One definition, used by every query that answers "may this manager see or decide
 * this?" — the members list, the leave queue, the correction queue and the approval
 * counts. Written once so they cannot disagree about who is in it.
 *
 *   hr_manager — their DIRECT reports: employees whose `manager_id` is them.
 *   hr_admin   — every other employee. HR's own administrators decide for anybody who
 *                has no manager, or whose manager is away.
 *
 * NEVER THEMSELVES, in either case. A manager's own request goes to their manager or to
 * HR; excluding it here, in the scope, means no route can forget to.
 */
export type TeamScope = {
  /** The signed-in manager's hr_users id. */
  managerId: number;
  /** True for hr_admin: the team is everyone except the manager. */
  everyone: boolean;
};

export function teamScopeFor(actor: HrActor): TeamScope {
  return { managerId: actor.id, everyone: actor.role === 'hr_admin' };
}

/**
 * The scope as a SQL condition on an hr_users alias, with its parameters.
 *
 * Returned as a fragment plus params rather than as a subquery so the caller's indexes
 * on `manager_id` are usable and the condition composes with the caller's own filters.
 */
export function teamCondition(scope: TeamScope, alias = 'u'): { sql: string; params: number[] } {
  if (scope.everyone) {
    return { sql: `${alias}.id <> ?`, params: [scope.managerId] };
  }
  return {
    sql: `${alias}.manager_id = ? AND ${alias}.id <> ?`,
    params: [scope.managerId, scope.managerId],
  };
}

/** Whether `userId` is on this manager's team. */
export async function isInTeam(scope: TeamScope, userId: number): Promise<boolean> {
  if (userId === scope.managerId) return false;
  const condition = teamCondition(scope);
  const row = await queryOne<RowDataPacket & { id: number }>(
    `SELECT u.id FROM hr_users u WHERE u.id = ? AND ${condition.sql} LIMIT 1`,
    [userId, ...condition.params],
  );
  return row !== null;
}
