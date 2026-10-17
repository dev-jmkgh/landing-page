'use client';

import { useId, useState } from 'react';
import { useDialogs } from '@/components/admin/ConfirmDialog';
import { ButtonSpinner } from '@/components/admin/Loader';
import { FileField, FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import type { HrEmployeeOption } from '@/lib/hrLeave';
import {
  HR_DOCUMENT_CATEGORIES,
  HR_DOCUMENT_CATEGORY_LABELS,
  HR_DOCUMENT_UPLOAD,
  checkHrDocumentFile,
  hrDocumentFormData,
  hrRequestsApi,
  titleFromFileName,
  type HrDocument,
  type HrDocumentCategory,
  type HrRequestCategory,
} from '@/lib/hrRequests';
import { EmployeePicker } from '../leave/EmployeePicker';
import { writeFailure } from '../leave/shared';

/**
 * Shares one document: a PDF, PNG or JPEG, with a title and a category, either with
 * every current employee or with one person.
 *
 * Two places use it. The Documents screen chooses the audience. A request's own page
 * passes `request`, and the document is then PERSONAL TO THE REQUESTER — the server sets
 * the owner from the request whatever is sent, so an employee's letter can never become
 * company-wide because the administrator forgot to pick their name — and it appears on
 * the request's timeline.
 *
 * A company-wide share is confirmed first: it notifies everyone.
 */

type FieldKey = 'file' | 'title' | 'category' | 'userId' | 'requestId';

/** A sensible category for a document answering a request of this kind. */
function categoryFor(category: HrRequestCategory | undefined): HrDocumentCategory {
  if (category === 'letter') return 'letter';
  if (category === 'payroll') return 'payroll';
  return 'other';
}

export type ShareResult = { document: HrDocument; recipients: number; message: string };

export function ShareDocumentForm({
  request,
  layout,
  onShared,
  onCancel,
  onUnauthorized,
}: {
  /** Share in answer to this request: personal to its employee. */
  request?: { id: number; employeeName: string; employeeCode: string; category: HrRequestCategory };
  /** `dialog`: a dialog body and foot. `card`: a plain form inside a card. */
  layout: 'dialog' | 'card';
  onShared: (result: ShareResult) => void;
  onCancel?: () => void;
  onUnauthorized: () => void;
}) {
  const dialogs = useDialogs();
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;

  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [category, setCategory] = useState<HrDocumentCategory>(categoryFor(request?.category));
  const [audience, setAudience] = useState<'company' | 'employee'>('employee');
  const [employee, setEmployee] = useState<HrEmployeeOption | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});

  const chooseFile = (next: File | null) => {
    setFile(next);
    setFieldErrors((errors) => ({ ...errors, file: next ? (checkHrDocumentFile(next) ?? undefined) : undefined }));
    setError(null);
    // The file's name is a reasonable first title, until somebody types their own.
    if (next && (!titleTouched || title.trim() === '')) {
      setTitle(titleFromFileName(next.name));
      setTitleTouched(false);
    }
  };

  const submit = async () => {
    const errors: Partial<Record<FieldKey, string>> = {};
    const cleanTitle = title.replace(/\s+/g, ' ').trim();

    if (!file) errors.file = 'Choose a file to upload.';
    else {
      const fileProblem = checkHrDocumentFile(file);
      if (fileProblem) errors.file = fileProblem;
    }
    if (cleanTitle.length < 2) errors.title = 'Give the document a title.';
    else if (cleanTitle.length > 160) errors.title = 'Keep the title to 160 characters or fewer.';
    if (!request && audience === 'employee' && !employee) errors.userId = 'Choose who the document is for.';

    if (Object.keys(errors).length > 0 || !file) {
      setFieldErrors(errors);
      setError('Check the highlighted fields.');
      return;
    }

    const companyWide = !request && audience === 'company';
    if (
      companyWide &&
      !(await dialogs.confirm({
        title: `Share “${cleanTitle}” with every current employee?`,
        message: 'Each of them is notified in the HR app and can open it.',
        confirmLabel: 'Share',
      }))
    ) {
      return;
    }

    setSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      const result = await hrRequestsApi.uploadDocument(
        hrDocumentFormData(file, {
          title: cleanTitle,
          category,
          userId: request || companyWide ? null : (employee?.id ?? null),
          requestId: request?.id ?? null,
        }),
      );

      const who = request
        ? request.employeeName
        : companyWide
          ? null
          : (result.document.employeeName ?? employee?.name ?? 'the employee');

      onShared({
        ...result,
        message: who
          ? `“${result.document.title}” is shared with ${who}, who is notified in the HR app.`
          : `“${result.document.title}” is shared with everyone. ${result.recipients} ${
              result.recipients === 1 ? 'employee was' : 'employees were'
            } notified.`,
      });
    } catch (caught) {
      const message = writeFailure(
        caught,
        onUnauthorized,
        'Only an administrator can share documents.',
        'The document could not be uploaded.',
      );
      if (message === null) return;
      if (caught instanceof ApiError) {
        setFieldErrors(caught.fieldErrors as Partial<Record<FieldKey, string>>);
        // A problem with the file itself is shown under the file; the banner says where.
        setError(caught.fieldErrors.file ? 'The file was not accepted — see below.' : message);
      } else {
        setError(message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const fields = (
    <>
      {error ? <FormAlert variant="error">{error}</FormAlert> : null}

      <FileField
        label="File"
        name="hr-document-file"
        file={file}
        accept={HR_DOCUMENT_UPLOAD.accept}
        onChange={chooseFile}
        required
        disabled={submitting}
        uploading={submitting}
        hint={`PDF, PNG or JPEG, up to ${HR_DOCUMENT_UPLOAD.maxSizeLabel}.`}
        error={fieldErrors.file}
      />

      <div className="tc-form__grid">
        <div className={`field${fieldErrors.title ? ' field--invalid' : ''}`}>
          <label className="field__label" htmlFor={id('title')}>
            Title
            <span className="field__required" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id={id('title')}
            className="input"
            maxLength={160}
            required
            value={title}
            disabled={submitting}
            placeholder="e.g. Employment verification letter"
            aria-invalid={fieldErrors.title ? true : undefined}
            aria-describedby={fieldErrors.title ? id('title-error') : id('title-hint')}
            onChange={(event) => {
              setTitle(event.target.value);
              setTitleTouched(true);
            }}
          />
          {fieldErrors.title ? (
            <p className="field__error" id={id('title-error')}>
              <Icon name="alert" size={14} />
              {fieldErrors.title}
            </p>
          ) : (
            <p className="field__hint" id={id('title-hint')}>
              What the employee sees in the app.
            </p>
          )}
        </div>

        <div className={`field${fieldErrors.category ? ' field--invalid' : ''}`}>
          <label className="field__label" htmlFor={id('category')}>
            Category
          </label>
          <select
            id={id('category')}
            className="select"
            value={category}
            disabled={submitting}
            aria-invalid={fieldErrors.category ? true : undefined}
            onChange={(event) => setCategory(event.target.value as HrDocumentCategory)}
          >
            {HR_DOCUMENT_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {HR_DOCUMENT_CATEGORY_LABELS[value]}
              </option>
            ))}
          </select>
          {fieldErrors.category ? <p className="field__error">{fieldErrors.category}</p> : null}
        </div>
      </div>

      {request ? (
        <p className="hrl-share-note">
          <Icon name="shield" size={15} />
          <span>
            Shared with <strong>{request.employeeName}</strong> ({request.employeeCode}) only, and
            added to this request&apos;s timeline.
          </span>
        </p>
      ) : (
        <fieldset className="tc-choice-list">
          <legend>Share with</legend>
          <div className="tc-choice">
            <label>
              <input
                type="radio"
                name={id('audience')}
                checked={audience === 'employee'}
                disabled={submitting}
                onChange={() => setAudience('employee')}
              />
              <span>One employee</span>
            </label>
            <label>
              <input
                type="radio"
                name={id('audience')}
                checked={audience === 'company'}
                disabled={submitting}
                onChange={() => setAudience('company')}
              />
              <span>Everyone (company-wide)</span>
            </label>
          </div>
          {audience === 'employee' ? (
            <EmployeePicker
              label="Employee"
              value={employee}
              onChange={(next) => {
                setEmployee(next);
                setFieldErrors((errors) => ({ ...errors, userId: undefined }));
              }}
              onUnauthorized={onUnauthorized}
              error={fieldErrors.userId ?? null}
              hint="Only this person can open it."
              disabled={submitting}
              inline
            />
          ) : (
            <p className="tc-dialog__note">
              Every current employee can open it, and each is notified in the HR app.
            </p>
          )}
          {fieldErrors.requestId ? <p className="field__error">{fieldErrors.requestId}</p> : null}
        </fieldset>
      )}
    </>
  );

  const submitButton = (
    <button
      type="submit"
      className="btn btn--primary"
      disabled={submitting}
      aria-busy={submitting || undefined}
    >
      {submitting ? <ButtonSpinner /> : <Icon name="upload" size={16} />}
      {submitting ? 'Uploading…' : 'Share document'}
    </button>
  );

  return (
    <form
      className={layout === 'dialog' ? 'hrl-dialog-form' : 'tc-form hrl-share-form'}
      noValidate
      aria-label={request ? `Share a document with ${request.employeeName}` : 'Share a document'}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {layout === 'dialog' ? (
        <>
          <div className="tc-dialog__body">{fields}</div>
          <div className="tc-dialog__foot">
            {onCancel ? (
              <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={submitting}>
                Cancel
              </button>
            ) : null}
            {submitButton}
          </div>
        </>
      ) : (
        <>
          {fields}
          <div className="hrl-form-actions">
            {submitButton}
            {onCancel ? (
              <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={submitting}>
                Cancel
              </button>
            ) : null}
          </div>
        </>
      )}
    </form>
  );
}
