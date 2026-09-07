import bcrypt from 'bcryptjs';
import { badRequest, notFound, validationFailed } from '../../../utils/httpError';
import { logger } from '../../../utils/logger';
import type { Actor } from '../actor';
import { revokeAllMobileSessions } from '../auth/mobileAuth.service';
import { recordAudit } from '../activity/activity.repository';
import {
  emailExists,
  employeeCodeExists,
  findEmployee,
  insertEmployee,
  nextEmployeeCode,
  readPasswordHash,
  updateEmployee,
  updatePasswordHash,
  type EmployeeRecord,
} from './employee.repository';
import type { CreateEmployeeInput, UpdateEmployeeInput } from './employee.schema';

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

  let employeeCode = input.employeeCode ?? (await nextEmployeeCode());

  if (input.employeeCode && (await employeeCodeExists(input.employeeCode))) {
    throw validationFailed({ employeeCode: 'That employee code is already in use.' });
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);

  let id: number;
  try {
    id = await insertEmployee({
      employeeCode,
      name: input.name,
      email: input.email,
      phone: input.phone,
      passwordHash,
      role: input.role,
      createdBy: actor.id,
    });
  } catch (error) {
    // Two admins adding staff in the same second both generated the same TC-#### code.
    // Recompute and retry once; a second collision means something else is wrong.
    if (isDuplicateKey(error) && !input.employeeCode) {
      employeeCode = await nextEmployeeCode();
      id = await insertEmployee({
        employeeCode,
        name: input.name,
        email: input.email,
        phone: input.phone,
        passwordHash,
        role: input.role,
        createdBy: actor.id,
      });
    } else if (isDuplicateKey(error)) {
      throw validationFailed({ email: 'An employee with that email or code already exists.' });
    } else {
      throw error;
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
    meta: { role: created.role, email: created.email },
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
 * Updates an employee.
 *
 * Two rules that are easy to get wrong and expensive to get wrong:
 *
 * 1. Nobody may change their own role. An admin who demotes themselves by accident
 *    locks the organisation out of employee management, and there is no self-service
 *    route back.
 * 2. Deactivating an employee revokes every mobile session they hold. Without that the
 *    handset keeps working until its refresh token expires — up to sixty days — which
 *    makes "deactivate" a label rather than an action.
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

  const changed = await updateEmployee(id, input);
  if (!changed) throw badRequest('Nothing to update.');

  const deactivated = input.isActive === false && existing.isActive;
  if (deactivated) {
    const revoked = await revokeAllMobileSessions(id);
    logger.info('Revoked mobile sessions for deactivated employee', { id, revoked });
  }

  const updated = await findEmployee(id);
  if (!updated) throw notFound('Employee not found.');

  await recordAudit({
    actor,
    action: deactivated ? 'employee_deactivated' : 'employee_updated',
    entityType: 'employee',
    entityId: id,
    summary: deactivated
      ? `Deactivated employee ${updated.name} (${updated.employeeCode})`
      : `Updated employee ${updated.name} (${updated.employeeCode})`,
    meta: describeChanges(existing, updated),
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
    'role',
    'employeeCode',
    'isActive',
  ];

  for (const key of keys) {
    if (before[key] !== after[key]) changes[key] = { from: before[key], to: after[key] };
  }

  return changes;
}

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
 * Self-service password change.
 *
 * Other devices are revoked; the one making the change is not, because signing the
 * employee out of the app they are currently using would be baffling. The route re-issues
 * that device's session afterwards.
 */
export async function changeOwnPassword(
  actor: Actor,
  currentPassword: string,
  newPassword: string,
  ipAddress: string | null,
): Promise<void> {
  const hash = await readPasswordHash(actor.id);
  if (!hash) throw notFound('Employee not found.');

  const matches = await bcrypt.compare(currentPassword, hash).catch(() => false);
  if (!matches) {
    throw validationFailed({ currentPassword: 'That is not your current password.' });
  }

  if (await bcrypt.compare(newPassword, hash).catch(() => false)) {
    throw validationFailed({ newPassword: 'Choose a password you have not used before.' });
  }

  await updatePasswordHash(actor.id, await bcrypt.hash(newPassword, BCRYPT_COST));
  await revokeAllMobileSessions(actor.id);

  await recordAudit({
    actor,
    action: 'employee_password_changed',
    entityType: 'employee',
    entityId: actor.id,
    summary: `${actor.name} changed their own password`,
    ipAddress,
  });
}
