'use client';

import { useState } from 'react';
import { ConfirmDialog, useRestoreFocus, useStableClose } from '@/components/admin/ConfirmDialog';
import { TextField } from '@/components/forms/Fields';
import { Dialog } from '@/components/ui/Dialog';
import { ApiError } from '@/lib/api';
import { peopleApi, type EmployeeDeleteResult, type HrEmployee } from '@/lib/hr';

/**
 * What an administrator does to an employee's ACCOUNT rather than their record: setting a
 * new password, and deleting them. Both run inside their dialog, which stays open showing
 * progress and keeps a failure in view.
 */

/* -------------------------------------------------------------------------- */
/* Reset password                                                              */
/* -------------------------------------------------------------------------- */

/*
 * No 0/O, 1/l/I: the password is read out or written down to hand over, and those are the
 * characters people mistake for each other.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/** A uniform pick: bytes past the last whole multiple of the alphabet are drawn again. */
function randomCharacter(): string {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  const byte = new Uint8Array(1);
  do {
    crypto.getRandomValues(byte);
  } while (byte[0]! >= limit);
  return ALPHABET[byte[0]! % ALPHABET.length]!;
}

/** `Kp7m-Qx4r-Tz9w`: 12 random characters in groups of four, easy to read back. */
export function generatePassword(): string {
  return Array.from({ length: 3 }, () => Array.from({ length: 4 }, randomCharacter).join('')).join('-');
}

const MIN_PASSWORD = 12;

export function ResetPasswordDialog({
  employee,
  onClose,
  onDone,
  onUnauthorized,
}: {
  employee: HrEmployee;
  onClose: () => void;
  /** The password is set; the message is for the page. */
  onDone: (message: string) => void;
  onUnauthorized: () => void;
}) {
  const [password, setPassword] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ sessionsRevoked: number } | null>(null);
  const [copied, setCopied] = useState(false);

  const firstName = employee.name.split(' ')[0] ?? employee.name;

  const change = (value: string) => {
    setPassword(value);
    setCopied(false);
    if (fieldError) setFieldError(undefined);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      // The browser refused (an insecure origin, or a denied permission); it stays on screen.
      setCopied(false);
    }
  };

  const save = async () => {
    if (password.length < MIN_PASSWORD) {
      setFieldError(`Use at least ${MIN_PASSWORD} characters.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await peopleApi.resetPassword(employee.id, password);
      setDone({ sessionsRevoked: result.sessionsRevoked });
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      if (caught instanceof ApiError && caught.fieldErrors?.password) {
        setFieldError(caught.fieldErrors.password);
      } else {
        setError(
          caught instanceof ApiError && caught.status === 403
            ? 'Only an administrator can reset a password.'
            : caught instanceof ApiError
              ? caught.message
              : 'Could not set the new password. Please try again.',
        );
      }
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    const signedOut =
      done.sessionsRevoked > 0
        ? `${firstName} was signed out of the HR app on ${done.sessionsRevoked === 1 ? 'one device' : `${done.sessionsRevoked} devices`}.`
        : `${firstName} was not signed in anywhere.`;
    return (
      <PasswordSetDialog
        title={`New password set for ${employee.name}`}
        password={password}
        copied={copied}
        onCopy={() => void copy()}
        onDone={() => onDone(`New password set for ${employee.name}. ${signedOut}`)}
      >
        <p className="dialog__text">
          {signedOut} Give them this password in person or by phone — it is not emailed, and it cannot be
          shown again once you close this.
        </p>
      </PasswordSetDialog>
    );
  }

  return (
    <ConfirmDialog
      title={`Reset ${employee.name}'s password`}
      confirmLabel="Set new password"
      busyLabel="Setting…"
      busy={busy}
      error={error}
      dismissOnBackdrop={false}
      onConfirm={() => void save()}
      onCancel={onClose}
    >
      <p className="dialog__text">
        Type a new password for the HR app, or generate one. {firstName} is signed out on every phone straight
        away and signs in again with this password.
      </p>
      <div className="tc-confirm-dialog__field">
        <TextField
          label="New password"
          name="hr-reset-password"
          // Plain text on purpose, as on Add employee: it has to be read out or written down.
          type="text"
          required
          value={password}
          error={fieldError}
          maxLength={200}
          autoComplete="off"
          hint={`At least ${MIN_PASSWORD} characters.`}
          onChange={change}
        />
        <div className="hrp-password-tools">
          <button type="button" className="btn btn--outline btn--sm" disabled={busy} onClick={() => change(generatePassword())}>
            Generate
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy || password.length === 0}
            onClick={() => void copy()}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </ConfirmDialog>
  );
}

/** The outcome, with the password still on screen until the administrator is done with it. */
function PasswordSetDialog({
  title,
  password,
  copied,
  onCopy,
  onDone,
  children,
}: {
  title: string;
  password: string;
  copied: boolean;
  onCopy: () => void;
  onDone: () => void;
  children: React.ReactNode;
}) {
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  );
  useRestoreFocus(opener);
  const close = useStableClose(onDone);

  return (
    <Dialog open onClose={close} title={title} className="tc-confirm-dialog" dismissOnBackdrop={false}>
      <div className="dialog__body">
        <h2 className="dialog__title tc-confirm-dialog__title">{title}</h2>
        <div className="tc-confirm-dialog__text">{children}</div>
        <p className="hrp-password-shown tc-mono" aria-label="The new password">
          {password}
        </p>
        <div className="tc-confirm-dialog__actions">
          <button type="button" className="btn btn--outline" onClick={onCopy}>
            {copied ? 'Copied' : 'Copy password'}
          </button>
          <button type="button" className="btn btn--primary" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Delete                                                                      */
/* -------------------------------------------------------------------------- */

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What the delete closed, in one sentence for the page. */
export function deleteSummary(result: EmployeeDeleteResult): string {
  if (result.alreadyDeleted) return `${result.name} had already been deleted. Nothing changed.`;
  const closed = [
    result.leaveCancelled > 0 ? `${plural(result.leaveCancelled, 'leave request', 'leave requests')} cancelled` : null,
    result.correctionsClosed > 0
      ? `${plural(result.correctionsClosed, 'attendance correction', 'attendance corrections')} closed`
      : null,
    result.requestsClosed > 0 ? `${plural(result.requestsClosed, 'HR request', 'HR requests')} closed` : null,
    result.payslipsRemoved > 0
      ? `${plural(result.payslipsRemoved, 'payslip', 'payslips')} removed from pay periods not yet approved`
      : null,
  ].filter(Boolean);
  const reports =
    result.reportsUnassigned > 0
      ? ` ${plural(result.reportsUnassigned, 'person', 'people')} who reported to them now ${
          result.reportsUnassigned === 1 ? 'has' : 'have'
        } no manager — set a new one on their record.`
      : '';
  return `${result.name} is deleted and signed out of the HR app.${
    closed.length > 0 ? ` ${closed.join(', ')}.` : ''
  }${reports}`;
}

export function DeleteEmployeeDialog({
  employee,
  onClose,
  onDeleted,
  onUnauthorized,
}: {
  employee: HrEmployee;
  onClose: () => void;
  onDeleted: (result: EmployeeDeleteResult) => void;
  onUnauthorized: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    if (typed.trim().toUpperCase() !== employee.employeeCode.toUpperCase()) {
      setFieldError(`Type ${employee.employeeCode} to confirm.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onDeleted(await peopleApi.deleteEmployee(employee.id));
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onUnauthorized();
      setError(
        caught instanceof ApiError && caught.status === 403
          ? 'Only an administrator can delete an employee.'
          : caught instanceof ApiError
            ? caught.message
            : 'Could not delete this employee. Please try again.',
      );
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      title={`Delete ${employee.name}?`}
      confirmLabel="Delete employee"
      busyLabel="Deleting…"
      danger
      busy={busy}
      error={error}
      dismissOnBackdrop={false}
      onConfirm={() => void remove()}
      onCancel={onClose}
    >
      <p className="dialog__text">This cannot be undone from the website. Straight away:</p>
      <ul className="hrp-consequences">
        <li>They are left out of the current pay period and every one after it. Approved payslips stay as paid.</li>
        <li>They are signed out of the HR app and cannot sign in again.</li>
        <li>Their pending leave, approved leave not yet started, open corrections and HR requests are closed.</li>
        <li>Anybody who reports to them is left without a manager.</li>
        <li>They disappear from the employee list. Their attendance, leave and payslip history is kept.</li>
      </ul>
      <div className="tc-confirm-dialog__field">
        <TextField
          label={`Type ${employee.employeeCode} to confirm`}
          name="hr-delete-confirm"
          value={typed}
          error={fieldError}
          maxLength={40}
          autoComplete="off"
          onChange={(value) => {
            setTyped(value);
            if (fieldError) setFieldError(undefined);
          }}
        />
      </div>
    </ConfirmDialog>
  );
}
