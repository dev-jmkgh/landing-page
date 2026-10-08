import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { PoolConnection } from 'mysql2/promise';
import { withTransaction } from '../../../db/pool';
import {
  badRequest,
  conflict,
  HttpError,
  notFound,
  validationFailed,
} from '../../../utils/httpError';
import { logger } from '../../../utils/logger';
import type { Actor } from '../actor';
import { revokeAllMobileSessions, revokeAllMobileSessionsTx } from '../auth/mobileAuth.service';
import { recordAudit } from '../activity/activity.repository';
import {
  countPendingFollowUpsLockedTx,
  pendingFollowUpBreakdown,
  type PendingFollowUpBreakdown,
} from '../followups/followUp.repository';
import {
  handoverFollowUpsTx,
  recordHandover,
  type HandoverOutcome,
  type HandoverSkippedRow,
} from '../followups/followUpMove.service';
import { companyPhoneKey } from '../shared.schema';
import {
  approveRegistration,
  companyPhoneHolder,
  countOpenLeads,
  deactivateEmployeeTx,
  emailExists,
  employeeCodeExists,
  findEmployee,
  findEmployeeCompanyLine,
  insertEmployee,
  lockEmployeeForUpdateTx,
  lockEmployeesForUpdateTx,
  lockPasswordAccountTx,
  nextEmployeeCode,
  readPasswordAccount,
  reopenRegistration,
  setCompanySimReport,
  updateEmployee,
  updateEmployeeTx,
  updatePasswordHash,
  updatePasswordHashTx,
  type CompanySimReport,
  type EmployeeRecord,
  type EmployeeUpdateFields,
  type InsertEmployeeData,
  type PasswordAccount,
} from './employee.repository';
import type {
  CompanySimReportInput,
  CreateEmployeeInput,
  DeactivateEmployeeInput,
  UpdateEmployeeInput,
} from './employee.schema';

/**
 * Employee management rules.
 *
 * Cost factor 12 matches the admin account hashing already in the project. It is a
 * deliberate ~250ms per verification: sign-in happens once a shift, and the delay is
 * what makes an offline attack on a stolen hash expensive.
 */
const BCRYPT_COST = 12;

/**
 * Creates an employee.
 *
 * Uniqueness is checked before the insert so the caller gets a field-level error on the
 * right input rather than a raw duplicate-key failure — but the unique indexes are still
 * the authority, and a race between two admins is caught below.
 */
export async function createEmployee(
  input: CreateEmployeeInput,
  actor: Actor,
  ipAddress: string | null,
): Promise<EmployeeRecord> {
  if (await emailExists(input.email)) {
    throw validationFailed({ email: 'An employee with that email address already exists.' });
  }

  if (input.employeeCode && (await employeeCodeExists(input.employeeCode))) {
    throw validationFailed({ employeeCode: 'That employee code is already in use.' });
  }

  const companyPhone = input.companyPhone ?? null;
  if (companyPhone) await assertCompanyPhoneFree(companyPhone, undefined, 'assign');

  const data: InsertEmployeeData = {
    employeeCode: input.employeeCode ?? (await nextEmployeeCode()),
    name: input.name,
    email: input.email,
    phone: input.phone,
    companyPhone,
    passwordHash: await bcrypt.hash(input.password, BCRYPT_COST),
    role: input.role,
    createdBy: actor.id,
  };

  let id: number | null = null;
  for (let attempt = 0; id === null; attempt += 1) {
    try {
      id = await insertEmployee(data);
    } catch (error) {
      // The company number was claimed by someone else between the check and the insert.
      if (isCompanyPhoneClash(error)) throw await companyPhoneTakenError(companyPhone, undefined, 'assign');

      // Two admins adding staff in the same second both generated the same TC-#### code.
      // Recompute and retry once; a second collision means something else is wrong.
      if (isDuplicateKey(error) && !input.employeeCode && attempt === 0) {
        data.employeeCode = await nextEmployeeCode();
      } else if (isDuplicateKey(error)) {
        throw validationFailed({ email: 'An employee with that email or code already exists.' });
      } else {
        throw error;
      }
    }
  }

  const created = await findEmployee(id);
  if (!created) throw notFound('Employee not found after creation.');

  await recordAudit({
    actor,
    action: 'employee_created',
    entityType: 'employee',
    entityId: id,
    summary: `Added employee ${created.name} (${created.employeeCode}) as ${created.role}`,
    meta: { role: created.role, email: created.email, companyPhone: created.companyPhone },
    ipAddress,
  });

  logger.info('Telecalling employee created', {
    id,
    employeeCode: created.employeeCode,
    role: created.role,
    by: actor.email,
  });

  return created;
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ER_DUP_ENTRY'
  );
}

/**
 * A duplicate on the company number's claim (migration 021) rather than on the email or
 * the employee code. Told apart by the index the driver names, so it is reported against
 * the company phone field instead of as a misleading "email already exists" — or, on a
 * reactivation, as a 500.
 */
function isCompanyPhoneClash(error: unknown): boolean {
  if (!isDuplicateKey(error)) return false;
  const { message, sqlMessage } = error as { message?: unknown; sqlMessage?: unknown };
  return `${String(message ?? '')} ${String(sqlMessage ?? '')}`.includes(
    'uq_telecaller_users_company_phone',
  );
}

type CompanyPhoneContext = 'assign' | 'reactivate';

function companyPhoneTaken(
  holder: { name: string; employeeCode: string },
  context: CompanyPhoneContext,
): HttpError {
  return validationFailed({
    companyPhone:
      context === 'reactivate'
        ? `That company number now belongs to ${holder.name} (${holder.employeeCode}). Change it before reactivating.`
        : `That company number belongs to ${holder.name} (${holder.employeeCode}).`,
  });
}

/**
 * Refuses a company number another live employee holds, naming them — asked before the
 * write so the admin learns who has the SIM instead of reading a duplicate-key error.
 * The unique index stays the authority; a race is mapped by `companyPhoneTakenError`.
 */
async function assertCompanyPhoneFree(
  companyPhone: string,
  exceptId: number | undefined,
  context: CompanyPhoneContext,
): Promise<void> {
  const key = companyPhoneKey(companyPhone);
  if (!key) return;
  const holder = await companyPhoneHolder(key, exceptId);
  if (holder) throw companyPhoneTaken(holder, context);
}

async function companyPhoneTakenError(
  companyPhone: string | null,
  exceptId: number | undefined,
  context: CompanyPhoneContext,
): Promise<HttpError> {
  const key = companyPhone ? companyPhoneKey(companyPhone) : null;
  const holder = key ? await companyPhoneHolder(key, exceptId) : null;
  return holder
    ? companyPhoneTaken(holder, context)
    : validationFailed({ companyPhone: 'That company number belongs to another employee.' });
}

/**
 * Updates an employee.
 *
 * Rules that are easy to get wrong and expensive to get wrong:
 *
 * 1. Nobody may change their own role. An admin who demotes themselves by accident
 *    locks the organisation out of employee management, and there is no self-service
 *    route back.
 * 2. Deactivating is refused while the employee holds pending follow-ups (409
 *    `pending_follow_ups`), decided inside ONE transaction that locks the employee's
 *    row, counts under a share lock and writes the whole edit — so nothing can book a
 *    follow-up onto them between the count and the switch-off (see the lock protocol on
 *    `resolveFollowUpAssigneeTx`). Refused, nothing is written: not the switch-off, not
 *    the other fields sent alongside it.
 * 3. Deactivating revokes every mobile session they hold, in that same transaction.
 *    Without that the handset keeps working until its refresh token expires — up to
 *    sixty days — which makes "deactivate" a label rather than an action.
 * 4. Activation is for an approved account that was switched off. A pending or rejected
 *    registration has a decision waiting, not a switch; flipping `is_active` on one made
 *    an unapproved applicant assignable and able to sign in.
 * 5. A company number is unique among live staff. Changing it clears the handset's SIM
 *    confirmation, which was about the old number; reactivating someone whose number has
 *    since been given to another employee is refused against that field.
 */
export async function editEmployee(
  id: number,
  input: UpdateEmployeeInput,
  actor: Actor,
  ipAddress: string | null,
): Promise<EmployeeRecord> {
  const existing = await findEmployee(id);
  if (!existing) throw notFound('Employee not found.');

  if (input.role !== undefined && input.role !== existing.role && id === actor.id) {
    throw badRequest('You cannot change your own role. Ask another administrator.');
  }

  if (input.isActive === false && id === actor.id) {
    throw badRequest('You cannot deactivate your own account.');
  }

  if (input.isActive === true && existing.approvalStatus !== 'approved') {
    throw badRequest('Approve the registration before activating this account.');
  }

  if (input.email !== undefined && input.email !== existing.email) {
    if (await emailExists(input.email, id)) {
      throw validationFailed({ email: 'An employee with that email address already exists.' });
    }
  }

  if (input.employeeCode !== undefined && input.employeeCode !== existing.employeeCode) {
    if (await employeeCodeExists(input.employeeCode, id)) {
      throw validationFailed({ employeeCode: 'That employee code is already in use.' });
    }
  }

  const companyPhoneChanged =
    input.companyPhone !== undefined && input.companyPhone !== existing.companyPhone;
  const reactivating = input.isActive === true && !existing.isActive;

  if (companyPhoneChanged && input.companyPhone) {
    await assertCompanyPhoneFree(input.companyPhone, id, 'assign');
  } else if (reactivating && !companyPhoneChanged && existing.companyPhone) {
    await assertCompanyPhoneFree(existing.companyPhone, id, 'reactivate');
  }

  const fields: EmployeeUpdateFields = { ...input, resetCompanySim: companyPhoneChanged };
  const deactivating = input.isActive === false && existing.isActive;
  let sessionsRevoked = 0;

  try {
    if (deactivating) {
      sessionsRevoked = await withTransaction(async (connection) => {
        const locked = await lockEmployeeForUpdateTx(connection, id);
        if (!locked) throw notFound('Employee not found.');

        await refuseWhilePendingTx(connection, id, locked.name);

        await updateEmployeeTx(connection, id, fields);
        return revokeAllMobileSessionsTx(connection, id);
      });
      logger.info('Revoked mobile sessions for deactivated employee', { id, revoked: sessionsRevoked });
    } else {
      const changed = await updateEmployee(id, fields);
      if (!changed) throw badRequest('Nothing to update.');
    }
  } catch (error) {
    if (isCompanyPhoneClash(error)) {
      throw await companyPhoneTakenError(
        companyPhoneChanged ? input.companyPhone ?? null : existing.companyPhone,
        id,
        companyPhoneChanged ? 'assign' : 'reactivate',
      );
    }
    throw error;
  }

  const updated = await findEmployee(id);
  if (!updated) throw notFound('Employee not found.');

  await recordAudit({
    actor,
    action: deactivating ? 'employee_deactivated' : 'employee_updated',
    entityType: 'employee',
    entityId: id,
    summary: deactivating
      ? `Deactivated employee ${updated.name} (${updated.employeeCode})`
      : `Updated employee ${updated.name} (${updated.employeeCode})`,
    meta: deactivating
      ? { ...describeChanges(existing, updated), pendingFollowUpsAtDeactivation: 0, sessionsRevoked }
      : describeChanges(existing, updated),
    ipAddress,
  });

  return updated;
}

/** What actually changed, for the audit entry. Never includes anything credential-shaped. */
function describeChanges(
  before: EmployeeRecord,
  after: EmployeeRecord,
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  const keys: (keyof EmployeeRecord)[] = [
    'name',
    'email',
    'phone',
    'companyPhone',
    'role',
    'employeeCode',
    'isActive',
  ];

  for (const key of keys) {
    if (before[key] !== after[key]) changes[key] = { from: before[key], to: after[key] };
  }

  return changes;
}

/* -------------------------------------------------------------------------- */
/* Deactivation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Refuses a deactivation while the employee holds pending follow-ups, inside the
 * deactivation's transaction and AFTER their row is locked FOR UPDATE.
 *
 * The count is a locking read, so it sees every follow-up a writer committed before the
 * lock was granted; any writer still to come share-locks the same row and waits, then
 * finds the account switched off. The breakdown in `details` is read on the same
 * connection, so it describes exactly what this transaction would have left behind —
 * which, after a handover inside it, is what could not be moved.
 */
async function refuseWhilePendingTx(
  connection: PoolConnection,
  id: number,
  name: string,
  skipped?: HandoverSkippedRow[],
): Promise<void> {
  const pending = await countPendingFollowUpsLockedTx(connection, id);
  if (pending === 0) return;

  const breakdown = await pendingFollowUpBreakdown(id, connection);
  throw conflict(pendingFollowUpsMessage(name, breakdown, skipped), 'pending_follow_ups', {
    pendingFollowUps: breakdown,
    ...(skipped ? { skipped } : {}),
  });
}

function pendingFollowUpsMessage(
  name: string,
  pending: PendingFollowUpBreakdown,
  skipped?: HandoverSkippedRow[],
): string {
  const count = `${pending.total} pending follow-up${pending.total === 1 ? '' : 's'}${
    pending.overdue > 0 ? ` (${pending.overdue} overdue)` : ''
  }`;

  if (skipped && skipped.length > 0) {
    return `${name} would still have ${count} after the move, because some could not be moved. Nothing was moved or changed — deal with those follow-ups, then try again.`;
  }
  return `${name} still has ${count}. Move them to another employee before deactivating.`;
}

export type DeactivationBlocker = {
  code: 'pending_follow_ups' | 'self' | 'already_inactive' | 'not_approved';
  message: string;
  count?: number;
};

export type DeactivationCheck = {
  employee: EmployeeRecord;
  pendingFollowUps: PendingFollowUpBreakdown;
  openLeads: number;
  canDeactivate: boolean;
  blockers: DeactivationBlocker[];
};

/**
 * Whether an employee can be deactivated now, and what stands in the way — for the
 * dialog that has to say so before anyone clicks. Read-only and unlocked: advice, not
 * the guard. The deactivation itself re-counts inside its transaction.
 */
export async function getDeactivationCheck(id: number, actor: Actor): Promise<DeactivationCheck> {
  const employee = await findEmployee(id);
  if (!employee) throw notFound('Employee not found.');

  const [pendingFollowUps, openLeads] = await Promise.all([
    pendingFollowUpBreakdown(id),
    countOpenLeads(id),
  ]);

  const blockers: DeactivationBlocker[] = [];

  if (pendingFollowUps.total > 0) {
    blockers.push({
      code: 'pending_follow_ups',
      message: pendingFollowUpsMessage(employee.name, pendingFollowUps),
      count: pendingFollowUps.total,
    });
  }
  if (id === actor.id) {
    blockers.push({ code: 'self', message: 'You cannot deactivate your own account.' });
  }
  if (employee.approvalStatus !== 'approved') {
    blockers.push({
      code: 'not_approved',
      message:
        employee.approvalStatus === 'pending'
          ? 'This registration is still waiting for a decision. Approve or reject it instead.'
          : 'This registration was rejected, so there is no account to deactivate.',
    });
  } else if (!employee.isActive) {
    blockers.push({ code: 'already_inactive', message: `${employee.name} is already deactivated.` });
  }

  return { employee, pendingFollowUps, openLeads, canDeactivate: blockers.length === 0, blockers };
}

export type DeactivateEmployeeResult = {
  employee: EmployeeRecord;
  handedOver: number;
  leadsTransferred: number;
  sessionsRevoked: number;
  batchId: string | null;
};

/**
 * Deactivates an employee, optionally moving every pending follow-up to someone else
 * first — atomically (`POST /employees/:id/deactivate`).
 *
 * One transaction: lock the employee (and the one receiving), hand the follow-ups over,
 * count what is left under the lock, switch the account off, revoke its sessions. If
 * anything would remain — a same-day duplicate the handover had to skip, say — the whole
 * thing is refused with 409 `pending_follow_ups` and rolled back, handover included:
 * there is no window in which the follow-ups have moved but the employee is still on,
 * or the employee is off and still holding work.
 *
 * Already deactivated: answered with the employee as it is, nothing done — a repeated
 * click is not an error.
 */
export async function deactivateEmployee(
  id: number,
  input: DeactivateEmployeeInput,
  actor: Actor,
  ipAddress: string | null,
): Promise<DeactivateEmployeeResult> {
  if (id === actor.id) throw badRequest('You cannot deactivate your own account.');

  const handover = input.handover;
  if (handover && handover.toEmployeeId === id) throw badRequest('Choose a different employee.');
  const batchId = handover ? randomUUID() : null;

  const committed = await withTransaction(async (connection) => {
    const locked = await lockEmployeesForUpdateTx(
      connection,
      handover ? [id, handover.toEmployeeId] : [id],
    );
    const employee = locked.find((row) => row.id === id);
    if (!employee) throw notFound('Employee not found.');

    if (employee.approvalStatus !== 'approved') {
      throw badRequest(
        employee.approvalStatus === 'pending'
          ? 'This registration is still waiting for a decision. Approve or reject it instead.'
          : 'This registration was rejected, so there is no account to deactivate.',
      );
    }
    if (!employee.isActive) return null;

    let outcome: HandoverOutcome | null = null;
    if (handover && batchId) {
      outcome = await handoverFollowUpsTx(connection, id, { ...handover }, actor, {
        batchId,
        kind: 'deactivation',
      });
    }

    await refuseWhilePendingTx(connection, id, employee.name, outcome?.skipped ?? undefined);

    await deactivateEmployeeTx(connection, id);
    const sessionsRevoked = await revokeAllMobileSessionsTx(connection, id);
    return { outcome, sessionsRevoked };
  });

  const employee = await findEmployee(id);
  if (!employee) throw notFound('Employee not found.');

  if (committed === null) {
    return { employee, handedOver: 0, leadsTransferred: 0, sessionsRevoked: 0, batchId: null };
  }

  const { outcome, sessionsRevoked } = committed;
  if (outcome && handover) {
    await recordHandover(outcome, handover, actor, ipAddress, 'deactivation');
  }

  const openLeads = await countOpenLeads(id);

  await recordAudit({
    actor,
    action: 'employee_deactivated',
    entityType: 'employee',
    entityId: id,
    summary: `Deactivated employee ${employee.name} (${employee.employeeCode})`,
    meta: {
      isActive: { from: true, to: false },
      pendingFollowUpsAtDeactivation: 0,
      handedOver: outcome?.moved ?? 0,
      handedOverTo: outcome?.to.id ?? null,
      leadsTransferred: outcome?.leadsTransferred ?? 0,
      batchId: outcome ? outcome.batchId : null,
      sessionsRevoked,
      openLeads,
      reason: input.reason,
    },
    ipAddress,
  });

  logger.info('Telecalling employee deactivated', {
    id,
    handedOver: outcome?.moved ?? 0,
    revoked: sessionsRevoked,
    by: actor.email,
  });

  return {
    employee,
    handedOver: outcome?.moved ?? 0,
    leadsTransferred: outcome?.leadsTransferred ?? 0,
    sessionsRevoked,
    batchId: outcome ? outcome.batchId : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Self-registration decisions                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Approves a registration (`POST /registrations/:id/approve`).
 *
 * An unconfirmed email address cannot be approved. This is the gate that makes
 * verification mandatory rather than advisory: sign-in already refuses an unverified
 * account, but without this an administrator could approve one and have an "approved"
 * employee who still cannot sign in, with nothing on either screen explaining why. It
 * also means approving is a decision about a person who has demonstrably read mail at
 * that address — a typo'd registration can never become a live account by being clicked
 * through. Refused rather than silently marked verified: only the applicant can prove
 * they control the mailbox.
 *
 * Nor can an account go live without a company SIM number. Registrations from older app
 * builds have none, so the admin supplies it here and it is saved in the same statement
 * as the approval; a number another live employee holds is refused against the field.
 */
export async function approvePendingRegistration(
  id: number,
  companyPhone: string | undefined,
  actor: Actor,
  ipAddress: string | null,
): Promise<EmployeeRecord> {
  const employee = await findEmployee(id);
  if (!employee) throw notFound('Registration not found.');

  if (employee.approvalStatus !== 'pending') {
    throw badRequest(
      employee.approvalStatus === 'approved'
        ? 'That registration has already been approved.'
        : 'That registration was rejected. Reopen it first if you want to approve it.',
    );
  }

  if (employee.emailVerifiedAt === null) {
    throw badRequest(
      `${employee.name} has not confirmed their email address yet. They need to enter the code sent to ${employee.email} before the account can be approved.`,
    );
  }

  if (employee.companyPhone === null && companyPhone === undefined) {
    throw badRequest(`Add ${employee.name}'s company SIM number before approving.`);
  }

  const newCompanyPhone =
    companyPhone !== undefined && companyPhone !== employee.companyPhone ? companyPhone : null;
  if (newCompanyPhone) await assertCompanyPhoneFree(newCompanyPhone, id, 'assign');

  let applied: boolean;
  try {
    applied = await approveRegistration(id, actor.id, newCompanyPhone);
  } catch (error) {
    if (isCompanyPhoneClash(error)) throw await companyPhoneTakenError(newCompanyPhone, id, 'assign');
    throw error;
  }

  if (!applied) {
    // Lost a race with another admin deciding the same registration.
    throw badRequest('That registration was just decided by someone else. Refresh and check.');
  }

  const approved = await findEmployee(id);
  if (!approved) throw notFound('Registration not found.');

  await recordAudit({
    actor,
    action: 'registration_approved',
    entityType: 'employee',
    entityId: id,
    summary: `Approved the registration of ${employee.name} (${employee.employeeCode})`,
    meta: {
      email: employee.email,
      registeredAt: employee.registeredAt,
      companyPhone: approved.companyPhone,
      companyPhoneAddedAtApproval: newCompanyPhone !== null,
    },
    ipAddress,
  });

  logger.info('Registration approved', {
    id,
    employeeCode: employee.employeeCode,
    by: actor.email,
  });

  return approved;
}

/**
 * Puts a rejected registration back in the queue (`POST /registrations/:id/reopen`).
 *
 * Exists because rejection is otherwise a dead end: the retained row blocks the address
 * from re-registering, so an admin who rejects the wrong person would have no route back
 * without editing the database.
 *
 * A rejected row releases its company number (its claim is NULL), and a pending one
 * claims it again — so if the number has been given to someone else in between, the
 * reopen is refused, naming who has it, rather than failing on the unique index.
 */
export async function reopenRejectedRegistration(
  id: number,
  actor: Actor,
  ipAddress: string | null,
): Promise<EmployeeRecord> {
  const employee = await findEmployee(id);
  if (!employee) throw notFound('Registration not found.');
  if (employee.approvalStatus !== 'rejected') {
    throw badRequest('Only a rejected registration can be reopened.');
  }

  const reopenRefused = async (): Promise<HttpError | null> => {
    const key = employee.companyPhone ? companyPhoneKey(employee.companyPhone) : null;
    const holder = key ? await companyPhoneHolder(key, id) : null;
    return holder
      ? badRequest(
          `That company number now belongs to ${holder.name} (${holder.employeeCode}). Change it before reopening.`,
        )
      : null;
  };

  const refusal = await reopenRefused();
  if (refusal) throw refusal;

  let applied: boolean;
  try {
    applied = await reopenRegistration(id);
  } catch (error) {
    if (isCompanyPhoneClash(error)) {
      throw (
        (await reopenRefused()) ??
        badRequest('That company number now belongs to another employee. Change it before reopening.')
      );
    }
    throw error;
  }
  if (!applied) throw badRequest('That registration could not be reopened. Refresh and check.');

  await recordAudit({
    actor,
    action: 'registration_reopened',
    entityType: 'employee',
    entityId: id,
    summary: `Reopened the registration of ${employee.name} (${employee.employeeCode})`,
    ipAddress,
  });

  const reopened = await findEmployee(id);
  if (!reopened) throw notFound('Registration not found.');
  return reopened;
}

/* -------------------------------------------------------------------------- */
/* Company SIM                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Records what the employee's phone says about the company SIM
 * (`PUT /mobile/profile/company-sim`).
 *
 * For the office's benefit — it is how an admin sees who has not set the SIM up. Whether
 * an individual call counts is still decided per call against `company_phone`.
 *
 * Idempotent: the phone re-sends this on every launch until it lands, so the row and the
 * audit log change only when the reported state does. A report made against a number an
 * admin has since changed is refused with 409 `company_number_changed`, so the phone asks
 * the employee to choose again instead of confirming a SIM for the wrong number.
 */
export async function reportCompanySim(
  actor: Actor,
  input: CompanySimReportInput,
  ipAddress: string | null,
): Promise<EmployeeRecord> {
  const line = await findEmployeeCompanyLine(actor.id);
  if (!line) throw notFound('Your profile could not be found.');

  if (!line.companyPhoneKey) {
    throw badRequest('Your company number has not been added yet. Ask your administrator to add it.');
  }

  const numberChanged = () =>
    conflict('Your company number has changed. Choose your company SIM again.', 'company_number_changed');

  if (input.confirmedFor !== line.companyPhoneKey) throw numberChanged();

  // A decline says the company SIM is not in this phone, so there is no slot or label.
  const report: CompanySimReport =
    input.status === 'confirmed'
      ? {
          status: 'confirmed',
          method: input.method ?? null,
          label: input.label,
          slot: input.slot ?? null,
          device: input.deviceName,
        }
      : { status: 'declined', method: null, label: null, slot: null, device: input.deviceName };

  const changed = await setCompanySimReport(actor.id, input.confirmedFor, report);

  if (!changed) {
    // Either nothing changed, or an admin changed the number a moment ago.
    const now = await findEmployeeCompanyLine(actor.id);
    if (now?.companyPhoneKey !== input.confirmedFor) throw numberChanged();
  } else {
    await recordAudit({
      actor,
      action: report.status === 'confirmed' ? 'company_sim_confirmed' : 'company_sim_declined',
      entityType: 'employee',
      entityId: actor.id,
      summary:
        report.status === 'confirmed'
          ? `${actor.name} confirmed the company SIM on ${report.device ?? 'their phone'}`
          : `${actor.name} reported the company SIM is not in ${report.device ?? 'their phone'}`,
      meta: {
        method: report.method,
        label: report.label,
        slot: report.slot,
        simCount: input.simCount,
        device: report.device,
      },
      ipAddress,
    });
  }

  const employee = await findEmployee(actor.id);
  if (!employee) throw notFound('Your profile could not be found.');
  return employee;
}

/* -------------------------------------------------------------------------- */
/* Passwords                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Administrative password reset.
 *
 * Revokes every device, always. The reason to reset a password is that the old one is
 * compromised or the handset is gone, and leaving live sessions running would defeat
 * the purpose entirely.
 */
export async function resetEmployeePassword(
  id: number,
  password: string,
  actor: Actor,
  ipAddress: string | null,
): Promise<void> {
  const existing = await findEmployee(id);
  if (!existing) throw notFound('Employee not found.');

  const hash = await bcrypt.hash(password, BCRYPT_COST);
  await updatePasswordHash(id, hash);
  const revoked = await revokeAllMobileSessions(id);

  await recordAudit({
    actor,
    action: 'employee_password_reset',
    entityType: 'employee',
    entityId: id,
    summary: `Reset the password for ${existing.name} (${existing.employeeCode})`,
    meta: { sessionsRevoked: revoked },
    ipAddress,
  });

  logger.info('Employee password reset', { id, revoked, by: actor.email });
}

/**
 * Why an account may no longer sign in, as the refusal the app acts on — the same codes
 * and words sign-in and `/auth/me` use — or null when it may.
 */
function accountRefusal(account: PasswordAccount): HttpError | null {
  if (account.approvalStatus === 'pending') {
    return new HttpError(403, 'Your account is still waiting for approval.', {
      code: 'approval_pending',
    });
  }
  if (account.approvalStatus === 'rejected') {
    return new HttpError(
      403,
      account.rejectionReason
        ? `Your registration was not approved: ${account.rejectionReason}`
        : 'Your registration was not approved.',
      { code: 'registration_rejected' },
    );
  }
  if (!account.isActive) {
    return new HttpError(403, 'Your account has been deactivated. Please speak to your administrator.', {
      code: 'account_deactivated',
    });
  }
  return null;
}

/**
 * Self-service password change.
 *
 * Other devices are revoked; the one making the change is not, because signing the
 * employee out of the app they are currently using would be baffling. The route re-issues
 * that device's session afterwards.
 *
 * An account that may no longer sign in is refused with 403 BEFORE anything is touched.
 * An access token outlives a deactivation by up to its lifetime, and this endpoint used
 * to accept one: it rewrote the password, revoked the sessions, and only then failed to
 * mint the new session — a 500, after changing a deactivated employee's credentials. The
 * state is checked first, and again under the row lock deactivation also takes, so a
 * deactivation landing while the new hash is computed cannot slip in between.
 */
export async function changeOwnPassword(
  actor: Actor,
  currentPassword: string,
  newPassword: string,
  ipAddress: string | null,
): Promise<void> {
  const account = await readPasswordAccount(actor.id);
  if (!account) throw notFound('Employee not found.');

  const refusal = accountRefusal(account);
  if (refusal) throw refusal;

  const matches = await bcrypt.compare(currentPassword, account.passwordHash).catch(() => false);
  if (!matches) {
    throw validationFailed({ currentPassword: 'That is not your current password.' });
  }

  if (await bcrypt.compare(newPassword, account.passwordHash).catch(() => false)) {
    throw validationFailed({ newPassword: 'Choose a password you have not used before.' });
  }

  // Hashed outside the transaction: ~250ms of work is not held under a row lock.
  const newHash = await bcrypt.hash(newPassword, BCRYPT_COST);

  await withTransaction(async (connection) => {
    const locked = await lockPasswordAccountTx(connection, actor.id);
    if (!locked) throw notFound('Employee not found.');

    const lateRefusal = accountRefusal(locked);
    if (lateRefusal) throw lateRefusal;

    // Reset by an administrator while this was being checked: the password just
    // verified is no longer the current one.
    if (locked.passwordHash !== account.passwordHash) {
      throw validationFailed({ currentPassword: 'That is not your current password.' });
    }

    await updatePasswordHashTx(connection, actor.id, newHash);
    await revokeAllMobileSessionsTx(connection, actor.id);
  });

  await recordAudit({
    actor,
    action: 'employee_password_changed',
    entityType: 'employee',
    entityId: actor.id,
    summary: `${actor.name} changed their own password`,
    ipAddress,
  });
}
