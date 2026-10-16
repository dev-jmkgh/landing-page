import { withTransaction } from '../../../db/pool';
import { badRequest, notFound } from '../../../utils/httpError';
import { logger } from '../../../utils/logger';
import { companyToday } from '../calendar/calendar.service';
import type { HrEmployeeProfile } from '../hr.schema';
import { hashHrPassword, nextHrEmployeeCode } from '../hrAuth.service';
import {
  findAccountState,
  findDepartment,
  findDesignation,
  findEmployee,
  hrEmailTaken,
  insertEmployee,
  managerChainTx,
  updateEmployeeTx,
  type EmployeeField,
} from './people.repository';
import type { EmployeeCreateInput, EmployeePatchInput } from './people.schema';

/**
 * The rules around an employee record: what a reference must point at, what the
 * reporting line may look like, and which dates make sense together.
 *
 * Refusals are thrown as 400s with a field-keyed `errors` object, so the admin form can
 * put each message beside the field that caused it.
 */

/** How far up a reporting line the cycle check walks before refusing. */
export const MAX_MANAGER_DEPTH = 50;

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ER_DUP_ENTRY'
  );
}

function isDeadlock(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
  return code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT';
}

const fieldError = (field: string, message: string) => badRequest(message, { [field]: message });

/* -------------------------------------------------------------------------- */
/* Reference checks                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A department or designation being newly assigned must exist AND be switched on.
 *
 * Switched-off entries stay on the people already in them (deactivating a department
 * does not move anybody), but nobody new is put into one — that is what switching it off
 * means. Only checked when the value CHANGES, so editing someone's phone number is not
 * refused because their department was retired last year.
 */
async function checkDepartment(id: number | null | undefined, current: number | null): Promise<void> {
  if (id === undefined || id === null || id === current) return;
  const department = await findDepartment(id);
  if (!department) throw fieldError('departmentId', 'That department does not exist.');
  if (!department.isActive) {
    throw fieldError('departmentId', `${department.name} is switched off. Switch it back on or pick another department.`);
  }
}

async function checkDesignation(id: number | null | undefined, current: number | null): Promise<void> {
  if (id === undefined || id === null || id === current) return;
  const designation = await findDesignation(id);
  if (!designation) throw fieldError('designationId', 'That designation does not exist.');
  if (!designation.isActive) {
    throw fieldError('designationId', `${designation.name} is switched off. Switch it back on or pick another designation.`);
  }
}

/**
 * A manager must be a real, APPROVED account. A pending or rejected registration is not
 * yet a person anyone reports to — and would receive the team's leave requests in an
 * app it cannot sign in to.
 */
async function checkManagerExists(managerId: number): Promise<void> {
  const manager = await findAccountState(managerId);
  if (!manager) throw fieldError('managerId', 'That manager does not exist.');
  if (manager.approvalStatus !== 'approved') {
    throw fieldError('managerId', `${manager.name} does not have an approved account yet.`);
  }
}

/** A date of birth is in the past and plausibly a living person's. */
function checkDateOfBirth(value: string | null | undefined): void {
  if (!value) return;
  if (value >= companyToday()) throw fieldError('dateOfBirth', 'Enter a date in the past.');
  if (value < '1900-01-01') throw fieldError('dateOfBirth', 'Check the year of birth.');
}

/* -------------------------------------------------------------------------- */
/* Create                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Creates an employee the administrator vouches for.
 *
 * The code comes from the SAME `EMP-` generator signup uses, and the insert retries on
 * a code collision exactly like signup does: two creations at once (or a creation racing
 * a signup) both compute the same next number, and the unique index decides. An email
 * collision is terminal and reported against the field.
 */
export async function createEmployee(
  input: EmployeeCreateInput,
  approvedBy: number | null,
): Promise<{ id: number; employeeCode: string }> {
  const email = input.email.trim().toLowerCase();

  if (await hrEmailTaken(email)) {
    throw fieldError('email', 'An HR account with that email address already exists.');
  }

  await checkDepartment(input.departmentId, null);
  await checkDesignation(input.designationId, null);
  if (input.managerId) await checkManagerExists(input.managerId);

  const passwordHash = await hashHrPassword(input.password);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const employeeCode = await nextHrEmployeeCode();
    try {
      const id = await insertEmployee({
        employeeCode,
        name: input.name,
        email,
        phone: input.phone,
        passwordHash,
        role: input.role,
        departmentId: input.departmentId ?? null,
        designationId: input.designationId ?? null,
        managerId: input.managerId ?? null,
        joiningDate: input.joiningDate ?? null,
        employmentType: input.employmentType,
        employmentStatus: input.employmentStatus,
        approvedBy,
      });
      logger.info('HR employee created by an administrator', { id, employeeCode, by: approvedBy });
      return { id, employeeCode };
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      if (await hrEmailTaken(email)) {
        throw fieldError('email', 'An HR account with that email address already exists.');
      }
      // Otherwise the code was taken by a concurrent creation: recompute and retry.
    }
  }

  throw new Error('Could not allocate an HR employee code after three attempts.');
}

/* -------------------------------------------------------------------------- */
/* Edit                                                                        */
/* -------------------------------------------------------------------------- */

export type FieldChange = { field: EmployeeField; before: unknown; after: unknown };

/** The profile value an API field corresponds to, for the before/after comparison. */
function currentValue(profile: HrEmployeeProfile, field: EmployeeField): string | number | null {
  return profile[field] ?? null;
}

/**
 * Applies an edit and returns what actually changed.
 *
 * A field sent with its current value is not a change, so the audit row lists only what
 * moved and a no-op save writes nothing at all.
 *
 * The reporting-line check runs INSIDE the transaction that writes the new manager, over
 * locked rows (see `managerChainTx`), so the check and the write cannot be separated by
 * somebody else's edit.
 */
export async function updateEmployee(id: number, input: EmployeePatchInput): Promise<FieldChange[]> {
  const current = await findEmployee(id);
  if (!current) throw notFound('Employee not found.');

  await checkDepartment(input.departmentId, current.departmentId);
  await checkDesignation(input.designationId, current.designationId);

  if (input.managerId !== undefined && input.managerId !== null) {
    if (input.managerId === id) throw fieldError('managerId', 'Someone cannot be their own manager.');
    if (input.managerId !== current.managerId) await checkManagerExists(input.managerId);
  }

  checkDateOfBirth(input.dateOfBirth);

  // The pair is checked as it will STAND after the edit, so changing one date alone is
  // still checked against the other one already on record.
  const joining = input.joiningDate !== undefined ? input.joiningDate : current.joiningDate;
  const exit = input.exitDate !== undefined ? input.exitDate : current.exitDate;
  if (joining && exit && exit < joining) {
    throw fieldError('exitDate', 'The exit date cannot be before the joining date.');
  }

  const changes: FieldChange[] = [];
  const writes: Partial<Record<EmployeeField, string | number | null>> = {};
  for (const [key, value] of Object.entries(input) as Array<[EmployeeField, unknown]>) {
    if (value === undefined) continue;
    const before = currentValue(current, key);
    const after = value as string | number | null;
    if (before === after) continue;
    changes.push({ field: key, before, after });
    writes[key] = after;
  }

  if (changes.length === 0) return changes;

  try {
    await withTransaction(async (connection) => {
      // Lock the employee row first: two edits to one person serialise here.
      await connection.execute('SELECT id FROM hr_users WHERE id = ? FOR UPDATE', [id]);

      if (writes.managerId !== undefined && writes.managerId !== null) {
        const { chain, truncated } = await managerChainTx(
          connection,
          Number(writes.managerId),
          MAX_MANAGER_DEPTH,
        );
        if (chain.includes(id)) {
          throw fieldError(
            'managerId',
            `That would make a loop in the reporting line: ${current.name} already manages that person, directly or through others.`,
          );
        }
        if (truncated) {
          throw fieldError(
            'managerId',
            `That reporting line is more than ${MAX_MANAGER_DEPTH} levels deep. Check it for a mistake.`,
          );
        }
      }

      await updateEmployeeTx(connection, id, writes);
    });
  } catch (error) {
    if (isDeadlock(error)) {
      throw badRequest('Another change to the reporting line was saved at the same moment. Reload and try again.');
    }
    throw error;
  }

  return changes;
}
