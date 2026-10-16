'use client';

import { useState } from 'react';
import { ButtonSpinner } from '@/components/admin/Loader';
import { FormAlert, TextField } from '@/components/forms/Fields';
import { Dialog } from '@/components/ui/Dialog';
import { peopleApi, type Department, type Designation } from '@/lib/hr';
import { classifyWriteError, unplacedErrors, useStableClose } from './shared';

/**
 * Adds or renames a department or a designation.
 *
 * One dialog for both because they are the same kind of thing — a named list entry
 * employees are filed under — and differ only in that a department may carry a short
 * code (FIN, OPS) for exports. Renaming is safe: employees point at the entry, not at its
 * name, so everybody in "Accounts" is in "Finance" the moment it is renamed.
 */

type Kind = 'department' | 'designation';

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,23}$/;

export function OrgEntryDialog({
  kind,
  entry,
  onClose,
  onSaved,
  onUnauthorized,
}: {
  kind: Kind;
  /** The entry being renamed, or null to add one. */
  entry: Department | Designation | null;
  onClose: () => void;
  onSaved: (message: string) => void;
  onUnauthorized: () => void;
}) {
  const close = useStableClose(onClose);
  const [name, setName] = useState(entry?.name ?? '');
  const [code, setCode] = useState(entry && 'code' in entry ? (entry.code ?? '') : '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const noun = kind === 'department' ? 'department' : 'designation';
  const title = entry ? `Edit ${entry.name}` : `Add a ${noun}`;

  const submit = async () => {
    setBanner(null);

    const cleanName = name.replace(/\s+/g, ' ').trim();
    const cleanCode = code.trim().toUpperCase();
    const local: Record<string, string> = {};
    if (cleanName.length < 2) local.name = 'Enter a name.';
    if (cleanName.length > 120) local.name = 'Keep it to 120 characters or fewer.';
    if (kind === 'department' && cleanCode && !CODE_PATTERN.test(cleanCode)) {
      local.code = 'Use up to 24 letters, digits, dashes or underscores.';
    }
    setErrors(local);
    if (Object.keys(local).length > 0) return;

    setSaving(true);
    try {
      if (kind === 'department') {
        const body = { name: cleanName, code: cleanCode || null };
        const saved = entry
          ? await peopleApi.updateDepartment(entry.id, body)
          : await peopleApi.createDepartment(body);
        onSaved(entry ? `${saved.name} saved.` : `${saved.name} added.`);
      } else {
        const saved = entry
          ? await peopleApi.updateDesignation(entry.id, { name: cleanName })
          : await peopleApi.createDesignation({ name: cleanName });
        onSaved(entry ? `${saved.name} saved.` : `${saved.name} added.`);
      }
    } catch (caught) {
      const outcome = classifyWriteError(caught);
      if (outcome.unauthorized) return onUnauthorized();
      if (outcome.forbidden) {
        setBanner(`Only an administrator can change ${noun}s.`);
        return;
      }
      setErrors(outcome.fields);
      const unplaced = unplacedErrors(outcome.fields, ['name', 'code']);
      setBanner(
        unplaced.length > 0
          ? unplaced.join(' ')
          : Object.keys(outcome.fields).length > 0
            ? null
            : outcome.message,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={close}
      title={title}
      className="tc-dialog hrp-dialog--narrow"
      dismissOnBackdrop={false}
    >
      <div className="tc-dialog__head">
        <p className="tc-dialog__eyebrow">{kind === 'department' ? 'Department' : 'Designation'}</p>
        <h2 className="tc-dialog__title">{title}</h2>
        {entry ? (
          <p className="tc-dialog__sub">
            {entry.employeeCount} active {entry.employeeCount === 1 ? 'employee' : 'employees'} — a
            new name applies to all of them at once.
          </p>
        ) : null}
      </div>

      <form
        className="hrp-dialog-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="tc-dialog__body">
          {banner ? <FormAlert variant="error">{banner}</FormAlert> : null}
          <TextField
            label="Name"
            name={`hr-org-${kind}-name`}
            required
            value={name}
            error={errors.name}
            maxLength={120}
            autoComplete="off"
            placeholder={kind === 'department' ? 'Finance' : 'Senior Executive'}
            onChange={setName}
          />
          {kind === 'department' ? (
            <TextField
              label="Code (optional)"
              name="hr-org-department-code"
              value={code}
              error={errors.code}
              maxLength={24}
              autoComplete="off"
              placeholder="FIN"
              hint="A short form for reports and exports. Saved in capitals."
              onChange={setCode}
            />
          ) : null}
        </div>

        <div className="tc-dialog__foot">
          <button type="button" className="btn btn--ghost" onClick={close} disabled={saving}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={saving}
            aria-busy={saving || undefined}
          >
            {saving ? <ButtonSpinner /> : null}
            {entry ? 'Save' : `Add ${noun}`}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
