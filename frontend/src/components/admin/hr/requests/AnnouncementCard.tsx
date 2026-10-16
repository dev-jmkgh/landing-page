'use client';

import { useEffect, useId, useState } from 'react';
import { ButtonSpinner } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import { hrRequestsApi, type HrDepartment } from '@/lib/hrRequests';
import { isAbort, readFailure, writeFailure } from '../leave/shared';

/**
 * Sends an announcement to every current employee's HR app inbox, or to one
 * department's.
 *
 * Confirmed before sending — it cannot be recalled — and the answer says how many people
 * it reached, because "sent" with nobody in the department is not the same as sent. The
 * server decides who counts as current (active, approved accounts) and audits the send.
 */

const TITLE_MAX = 160;
const BODY_MAX = 500;

type FieldKey = 'title' | 'body' | 'departmentId';

export function AnnouncementCard({ onUnauthorized }: { onUnauthorized: () => void }) {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [departments, setDepartments] = useState<HrDepartment[] | null>(null);
  const [departmentsError, setDepartmentsError] = useState<string | null>(null);

  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [result, setResult] = useState<{ tone: 'success' | 'info'; text: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    hrRequestsApi
      .listDepartments(controller.signal)
      .then(setDepartments)
      .catch((caught: unknown) => {
        if (isAbort(caught)) return;
        const message = readFailure(caught, onUnauthorized, 'Departments could not be loaded.');
        if (message !== null) {
          setDepartmentsError(`${message} The announcement can still go to everyone.`);
          setDepartments([]);
        }
      });
    return () => controller.abort();
  }, [onUnauthorized]);

  const department = departments?.find((item) => String(item.id) === departmentId) ?? null;

  const send = async () => {
    const cleanTitle = title.replace(/\s+/g, ' ').trim();
    const cleanBody = body.trim();
    const errors: Partial<Record<FieldKey, string>> = {};
    if (cleanTitle.length < 3) errors.title = 'Add a title (at least 3 characters).';
    else if (cleanTitle.length > TITLE_MAX) errors.title = `Keep the title to ${TITLE_MAX} characters or fewer.`;
    if (cleanBody.length > BODY_MAX) errors.body = `Keep the message to ${BODY_MAX} characters or fewer.`;

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setError('Check the highlighted fields.');
      return;
    }

    const audience = department ? `everyone in ${department.name}` : 'every current employee';
    if (
      !window.confirm(
        `Send “${cleanTitle}” to ${audience}?\n\nIt appears in their HR app inbox straight away and cannot be recalled.`,
      )
    ) {
      return;
    }

    setSending(true);
    setError(null);
    setFieldErrors({});
    setResult(null);

    try {
      const recipients = await hrRequestsApi.broadcast({
        title: cleanTitle,
        ...(cleanBody ? { body: cleanBody } : {}),
        ...(department ? { departmentId: department.id } : {}),
      });
      setResult(
        recipients === 0
          ? {
              tone: 'info',
              text: department
                ? `Nobody received “${cleanTitle}”: ${department.name} has no current employees.`
                : `Nobody received “${cleanTitle}”: there are no current employees.`,
            }
          : {
              tone: 'success',
              text: `“${cleanTitle}” was sent to ${recipients} ${recipients === 1 ? 'employee' : 'employees'}${
                department ? ` in ${department.name}` : ''
              }.`,
            },
      );
      setTitle('');
      setBody('');
    } catch (caught) {
      const message = writeFailure(
        caught,
        onUnauthorized,
        'Only an administrator can send announcements.',
        'The announcement could not be sent.',
      );
      if (message === null) return;
      if (caught instanceof ApiError) setFieldErrors(caught.fieldErrors as Partial<Record<FieldKey, string>>);
      setError(message);
    } finally {
      setSending(false);
    }
  };

  const errorLine = (key: FieldKey) =>
    fieldErrors[key] ? (
      <p className="field__error" id={id(`${key}-error`)}>
        <Icon name="alert" size={14} />
        {fieldErrors[key]}
      </p>
    ) : null;

  return (
    <section className="tc-card hrl-card hrl-announce" aria-labelledby={id('title-heading')}>
      <div className="hrl-card__head">
        <span className="hrl-card__icon" aria-hidden="true">
          <Icon name="megaphone" size={18} />
        </span>
        <h3 className="hrl-card__title" id={id('title-heading')}>
          Announcements
        </h3>
      </div>
      <p className="tc-muted">
        A short notice in every employee&apos;s HR app inbox — an office closure, a policy
        reminder. For a file, share a company-wide document instead.
      </p>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {result ? <FormAlert variant={result.tone}>{result.text}</FormAlert> : null}

      <form
        className="tc-form hrl-announce__form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
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
              maxLength={TITLE_MAX}
              required
              value={title}
              disabled={sending}
              placeholder="e.g. Office closed on Friday"
              aria-invalid={fieldErrors.title ? true : undefined}
              aria-describedby={fieldErrors.title ? id('title-error') : undefined}
              onChange={(event) => setTitle(event.target.value)}
            />
            {errorLine('title')}
          </div>

          <div className={`field${fieldErrors.departmentId ? ' field--invalid' : ''}`}>
            <label className="field__label" htmlFor={id('department')}>
              Send to
            </label>
            <select
              id={id('department')}
              className="select"
              value={departmentId}
              disabled={sending || departments === null}
              aria-describedby={id('department-hint')}
              onChange={(event) => setDepartmentId(event.target.value)}
            >
              <option value="">Every current employee</option>
              {(departments ?? [])
                .filter((item) => item.isActive || String(item.id) === departmentId)
                .map((item) => (
                  /*
                    No head count beside the name: the department's count includes
                    switched-off accounts, which do not receive it, and the reply says
                    exactly how many did.
                  */
                  <option key={item.id} value={item.id}>
                    {item.name} only
                  </option>
                ))}
            </select>
            {fieldErrors.departmentId ? (
              errorLine('departmentId')
            ) : (
              <p className="field__hint" id={id('department-hint')}>
                {departmentsError ?? 'Active, approved accounts receive it.'}
              </p>
            )}
          </div>
        </div>

        <div className={`field${fieldErrors.body ? ' field--invalid' : ''}`}>
          <label className="field__label" htmlFor={id('body')}>
            Message (optional)
          </label>
          <textarea
            id={id('body')}
            className="textarea tc-textarea--short"
            maxLength={BODY_MAX}
            value={body}
            disabled={sending}
            placeholder="The details people need."
            aria-invalid={fieldErrors.body ? true : undefined}
            aria-describedby={fieldErrors.body ? id('body-error') : id('body-hint')}
            onChange={(event) => setBody(event.target.value)}
          />
          {fieldErrors.body ? (
            errorLine('body')
          ) : (
            <p className="field__hint" id={id('body-hint')}>
              {BODY_MAX - body.length} characters left.
            </p>
          )}
        </div>

        <button type="submit" className="btn btn--primary" disabled={sending} aria-busy={sending || undefined}>
          {sending ? <ButtonSpinner /> : <Icon name="megaphone" size={16} />}
          {sending ? 'Sending…' : 'Send announcement'}
        </button>
      </form>
    </section>
  );
}
