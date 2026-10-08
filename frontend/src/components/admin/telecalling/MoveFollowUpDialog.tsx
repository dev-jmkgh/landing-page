'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ButtonSpinner, Loader } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Dialog } from '@/components/ui/Dialog';
import { ApiError } from '@/lib/api';
import {
  LEAD_STATUS_LABELS,
  formatDateTime,
  formatTime,
  istParts,
  istToIso,
  telecallingApi,
  todayIso,
  type Employee,
  type FollowUp,
  type LeadListItem,
  type LeadStatus,
  type MoveFollowUpBody,
  type MoveFollowUpResult,
} from '@/lib/telecalling';
import { LeadStatusBadge, Tag } from './shared';

/**
 * Moving one follow-up (Req 8): a new date and time, a different lead, a different
 * employee — any of them, in one step, through POST /follow-ups/:id/move.
 *
 * The form shows what the follow-up is now beside what it will become, row by row, so a
 * move is checked before it is made rather than discovered afterwards. It sends only what
 * changed, plus `expected`: the values it showed as current. If someone else moved the
 * follow-up while this was open, the server refuses with 409 instead of silently
 * overwriting their change, and the form hands back to its screen to reload.
 *
 * The date and time are typed as IST wall-clock values and converted with `istToIso`,
 * whatever zone the admin's laptop is set to — the browser's own clock never decides
 * what "10:00" means.
 *
 * Split into the form and the dialog around it because the deactivation dialog moves a
 * single skipped follow-up with the same form, as a step inside itself. A dialog opened
 * on top of another would trap focus and Escape twice over.
 */

/** The lead a follow-up is on, or is going to: what the form shows and decides with. */
type LeadChoice = {
  id: number;
  customerName: string;
  reference: string;
  phone: string;
  status: LeadStatus;
  ownerId: number | null;
  ownerName: string | null;
};

function leadOfFollowUp(followUp: FollowUp): LeadChoice {
  return {
    id: followUp.leadId,
    customerName: followUp.leadName,
    reference: followUp.leadReference,
    phone: followUp.leadPhone,
    status: followUp.leadStatus,
    ownerId: followUp.leadAssignedTo,
    ownerName: followUp.leadAssignedToName,
  };
}

function leadOfListItem(lead: LeadListItem): LeadChoice {
  return {
    id: lead.id,
    customerName: lead.customerName,
    reference: lead.reference,
    phone: lead.phone,
    status: lead.status,
    ownerId: lead.assignedTo,
    ownerName: lead.assignedToName,
  };
}

/** A follow-up on a lead in one of these is allowed, but usually a mistake worth naming. */
const CLOSED_STATUSES: readonly LeadStatus[] = ['converted', 'lost', 'not_interested', 'invalid_number'];

/** Statuses that promise a follow-up; moving the last one away breaks that promise. */
const STATUSES_EXPECTING_FOLLOW_UP: readonly LeadStatus[] = ['follow_up', 'callback_requested'];

/*
 * The default of the `calling.working_hours` setting. A supervisor cannot read /settings,
 * so the default stands in, and only as advice: a 19:00 callback a customer asked for is
 * a perfectly good follow-up.
 */
const CALLING_HOURS = { start: '09:30', end: '18:30', label: '09:30 am – 06:30 pm' };

/** The spec caps lead pickers at ten rows; eight fit the dialog without scrolling. */
const LEAD_SEARCH_PAGE_SIZE = 8;

/** The server's own limits on a new due time, repeated here to say so before sending. */
const MAX_AHEAD_MS = 2 * 365 * 86_400_000;

/** Field keys the server may return in a 422, each shown under its own input. */
const FIELD_KEYS = ['dueAt', 'leadId', 'assignedTo', 'note', 'reason'] as const;

export type MoveFollowUpFormProps = {
  followUp: FollowUp;
  /** Who a follow-up may be given to: active, approved staff (`assignableEmployees`). */
  employees: Employee[];
  /** Preselects a new employee — how the inline "Assigned to" select opens the form. */
  initialAssignedTo?: number;
  /** A heading inside the body, for when the form is a step of another dialog. */
  heading?: string;
  cancelLabel?: string;
  onCancel: () => void;
  onMoved: (result: MoveFollowUpResult) => void;
  /**
   * The follow-up changed underneath the form — moved by someone else, completed or
   * cancelled (409 `follow_up_changed` / `follow_up_not_pending`). The screen should close
   * the form, say so and reload: nothing the form shows can be trusted any more.
   */
  onStale: (message: string) => void;
  onUnauthorized: () => void;
  /**
   * Offered beside a duplicate refusal: shows the follow-up the move would have doubled.
   * Given the lead it is on. Left out where there is nowhere to show it.
   */
  onShowExisting?: (lead: { id: number; reference: string }) => void;
};

export function MoveFollowUpForm({
  followUp,
  employees,
  initialAssignedTo,
  heading,
  cancelLabel = 'Cancel',
  onCancel,
  onMoved,
  onStale,
  onUnauthorized,
  onShowExisting,
}: MoveFollowUpFormProps) {
  const uid = useId();
  const fieldId = (name: string) => `${uid}-${name}`;

  /* --------------------------------------------------------- what it is now */

  const currentLead = useMemo(() => leadOfFollowUp(followUp), [followUp]);
  const original = useMemo(() => istParts(followUp.dueAt), [followUp.dueAt]);
  const originalDate = original?.date ?? '';
  const originalTime = original?.time ?? '';

  const assignableIds = useMemo(() => new Set(employees.map((employee) => employee.id)), [employees]);
  const currentAssignable = followUp.assignedTo !== null && assignableIds.has(followUp.assignedTo);

  /* ------------------------------------------------------- what it will be */

  const [date, setDate] = useState(originalDate);
  const [time, setTime] = useState(originalTime);
  const [assigneeId, setAssigneeId] = useState<number | null>(
    initialAssignedTo ?? followUp.assignedTo,
  );
  const [lead, setLead] = useState<LeadChoice>(currentLead);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');

  /*
   * "Also make them the owner of the lead" has a default that depends on the employee and
   * lead chosen, and follows those choices until the admin touches the box. After that,
   * their choice stands.
   */
  const [transferTouched, setTransferTouched] = useState(false);
  const [transferChoice, setTransferChoice] = useState(false);

  /* ----------------------------------------------------------- submitting */

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  /** A 409 `duplicate_follow_up`: the server's sentence, which names the clash. */
  const [duplicate, setDuplicate] = useState<string | null>(null);

  /* ---------------------------------------------------------- lead search */

  const [picking, setPicking] = useState(false);
  const [leadQuery, setLeadQuery] = useState('');
  const [leadResults, setLeadResults] = useState<{
    query: string;
    items: LeadListItem[];
    total: number;
  } | null>(null);
  const [leadSearching, setLeadSearching] = useState(false);
  const [leadSearchError, setLeadSearchError] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (picking) searchInput.current?.focus();
  }, [picking]);

  useEffect(() => {
    if (!picking) return undefined;

    const query = leadQuery.trim();
    // One character matches half the lead table; wait for something worth searching for.
    if (query.length < 2) {
      setLeadResults(null);
      setLeadSearching(false);
      setLeadSearchError(null);
      return undefined;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLeadSearching(true);
      setLeadSearchError(null);

      telecallingApi
        .listLeads({ q: query, pageSize: LEAD_SEARCH_PAGE_SIZE }, controller.signal)
        .then((page) => setLeadResults({ query, items: page.items, total: page.total }))
        .catch((caught: unknown) => {
          if (caught instanceof DOMException && caught.name === 'AbortError') return;
          if (caught instanceof ApiError && caught.status === 401) {
            onUnauthorized();
            return;
          }
          setLeadSearchError(
            caught instanceof ApiError ? caught.message : 'Could not search the leads.',
          );
        })
        .finally(() => {
          // A newer keystroke owns the spinner now.
          if (!controller.signal.aborted) setLeadSearching(false);
        });
    }, 350);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [picking, leadQuery, onUnauthorized]);

  const chooseLead = (choice: LeadChoice) => {
    setLead(choice);
    setPicking(false);
    setLeadQuery('');
    setLeadResults(null);
    setServerErrors((errors) => withoutKey(errors, 'leadId'));
    setDuplicate(null);
  };

  /* ------------------------------------------------- source-lead advice */

  const leadChanged = lead.id !== followUp.leadId;

  /*
   * How many pending follow-ups the lead being left has, fetched only when that matters:
   * the lead is moving and its status promises a follow-up. One row of one page — the
   * total is all that is wanted.
   */
  const [sourcePending, setSourcePending] = useState<number | null>(null);
  const needsSourceCount =
    leadChanged && STATUSES_EXPECTING_FOLLOW_UP.includes(followUp.leadStatus);

  useEffect(() => {
    if (!needsSourceCount || sourcePending !== null) return undefined;

    const controller = new AbortController();
    telecallingApi
      .listFollowUps({ scope: 'pending', leadId: followUp.leadId, pageSize: 1 }, controller.signal)
      .then((page) => setSourcePending(page.total))
      // Advice only: without the count the warning is simply not shown.
      .catch(() => undefined);

    return () => controller.abort();
  }, [needsSourceCount, sourcePending, followUp.leadId]);

  /* -------------------------------------------------------------- derived */

  const timeChanged = date !== originalDate || time !== originalTime;
  const newDueIso = timeChanged ? istToIso(date, time) : null;
  const assigneeChanged = assigneeId !== followUp.assignedTo;
  const assigneeAssignable = assigneeId !== null && assignableIds.has(assigneeId);

  const employeeName = (id: number | null): string => {
    if (id === null) return 'Unassigned';
    return (
      employees.find((employee) => employee.id === id)?.name ??
      (id === followUp.assignedTo ? followUp.assignedToName : null) ??
      'Former employee'
    );
  };

  const assigneeName = employeeName(assigneeId);

  let dueError: string | null = null;
  if (timeChanged) {
    if (newDueIso === null) dueError = 'Enter a real date and time.';
    else if (Date.parse(newDueIso) <= Date.now()) dueError = 'Choose a time in the future.';
    else if (Date.parse(newDueIso) >= Date.now() + MAX_AHEAD_MS) {
      dueError = 'That date is too far in the future.';
    }
  }

  const ownerActive = lead.ownerId !== null && assignableIds.has(lead.ownerId);
  const transferApplies = assigneeId !== null && assigneeId !== lead.ownerId;
  // On by default when nobody who can work the lead owns it; off when someone active does.
  const transferDefault = !ownerActive;
  const transferLead = transferApplies && (transferTouched ? transferChoice : transferDefault);

  const anythingChanged = timeChanged || leadChanged || assigneeChanged;
  const canSubmit = anythingChanged && dueError === null && assigneeAssignable && !submitting;

  const advice: string[] = [];

  if (timeChanged && newDueIso !== null && dueError === null) {
    if (time < CALLING_HOURS.start || time > CALLING_HOURS.end) {
      advice.push(
        `${formatTime(newDueIso)} is outside the usual calling hours (${CALLING_HOURS.label} IST).`,
      );
    }
  }

  if (transferApplies && !transferLead && assigneeAssignable) {
    advice.push(
      `${assigneeName} will see this follow-up but cannot open the lead or log calls against it in the app — ${lead.customerName}'s lead stays with ${lead.ownerName ?? 'nobody'}.`,
    );
  }

  if (leadChanged && CLOSED_STATUSES.includes(lead.status)) {
    advice.push(
      `${lead.customerName} is marked “${LEAD_STATUS_LABELS[lead.status]}”. Check that a follow-up is still wanted.`,
    );
  }

  if (needsSourceCount && sourcePending !== null && sourcePending <= 1) {
    advice.push(
      `${followUp.leadName} is marked “${LEAD_STATUS_LABELS[followUp.leadStatus]}” and will have no follow-up left after this move.`,
    );
  }

  const fieldError = (key: (typeof FIELD_KEYS)[number]): string | null =>
    serverErrors[key] ?? null;

  const submit = async () => {
    if (!canSubmit) return;

    const body: MoveFollowUpBody = {
      expected: {
        dueAt: followUp.dueAt,
        assignedTo: followUp.assignedTo,
        leadId: followUp.leadId,
      },
    };
    if (timeChanged && newDueIso !== null) body.dueAt = newDueIso;
    if (leadChanged) body.leadId = lead.id;
    if (assigneeChanged && assigneeId !== null) body.assignedTo = assigneeId;
    if (note.trim()) body.note = note.trim();
    if (reason.trim()) body.reason = reason.trim();
    if (transferLead) body.transferLead = true;

    setSubmitting(true);
    setError(null);
    setServerErrors({});
    setDuplicate(null);

    try {
      onMoved(await telecallingApi.moveFollowUp(followUp.id, body));
    } catch (caught) {
      if (!(caught instanceof ApiError)) {
        setError('Could not move the follow-up.');
        return;
      }
      if (caught.status === 401) {
        onUnauthorized();
        return;
      }
      if (caught.status === 403) {
        setError('Moving follow-ups needs a supervisor, manager or administrator account.');
        return;
      }
      if (
        caught.status === 409 &&
        (caught.code === 'follow_up_changed' || caught.code === 'follow_up_not_pending')
      ) {
        onStale(caught.message);
        return;
      }
      if (caught.status === 409 && caught.code === 'duplicate_follow_up') {
        setDuplicate(caught.message);
        return;
      }
      if (caught.status === 422 || Object.keys(caught.fieldErrors).length > 0) {
        setServerErrors(caught.fieldErrors);
        // Errors with no input of their own — the body as a whole, `expected` — are spelt
        // out in the banner rather than hidden behind "check the highlighted fields".
        const unplaced = Object.entries(caught.fieldErrors)
          .filter(([key]) => !(FIELD_KEYS as readonly string[]).includes(key))
          .map(([, message]) => message);
        setError(unplaced.length > 0 ? unplaced.join(' ') : caught.message);
        return;
      }
      setError(caught.message);
    } finally {
      setSubmitting(false);
    }
  };

  /* --------------------------------------------------------------- render */

  return (
    <>
      <div className="tc-dialog__body">
        {heading ? <h3 className="tc-dialog__section-title">{heading}</h3> : null}

        {error ? <FormAlert variant="error">{error}</FormAlert> : null}

        <section className="tc-dialog__section" aria-labelledby={fieldId('current')}>
          <h3 className="tc-dialog__section-title" id={fieldId('current')}>
            Current
          </h3>
          <dl className="tc-facts">
            <dt>Customer</dt>
            <dd>
              <span>{followUp.leadName}</span>
              <span className="tc-mono">{followUp.leadReference}</span>
              <span className="tc-muted">{followUp.leadPhone}</span>
              <LeadStatusBadge status={followUp.leadStatus} />
            </dd>

            <dt>Due</dt>
            <dd>
              <span>{formatDateTime(followUp.dueAt)} IST</span>
              {followUp.isOverdue ? <Tag tone="bad">Overdue</Tag> : null}
            </dd>

            <dt>Assigned to</dt>
            <dd>
              <span>{followUp.assignedToName ?? 'Unassigned'}</span>
              {followUp.assignedTo !== null && !currentAssignable ? (
                <Tag tone="warn">Deactivated</Tag>
              ) : null}
            </dd>

            <dt>Lead owner</dt>
            <dd>{followUp.leadAssignedToName ?? 'Unassigned'}</dd>

            {followUp.rescheduleCount > 0 ? (
              <>
                <dt>History</dt>
                <dd>
                  Moved {followUp.rescheduleCount}{' '}
                  {followUp.rescheduleCount === 1 ? 'time' : 'times'} before
                </dd>
              </>
            ) : null}

            {followUp.note ? (
              <>
                <dt>Note</dt>
                <dd>
                  <span className="tc-note tc-note--open">{followUp.note}</span>
                </dd>
              </>
            ) : null}
          </dl>
        </section>

        <section className="tc-dialog__section" aria-labelledby={fieldId('new')}>
          <h3 className="tc-dialog__section-title" id={fieldId('new')}>
            Move to
          </h3>

          {/* ------------------------------------------------------------ lead */}
          <div className={`field${fieldError('leadId') ? ' field--invalid' : ''}`}>
            <span className="field__label" id={fieldId('lead-label')}>
              Lead
            </span>
            <div className="tc-lead-choice" role="group" aria-labelledby={fieldId('lead-label')}>
              <span>
                {lead.customerName} <span className="tc-mono">{lead.reference}</span>
              </span>
              {leadChanged ? <Tag tone="progress">Changed</Tag> : null}
              <button
                type="button"
                className="tc-text-button"
                aria-expanded={picking}
                aria-controls={fieldId('lead-search')}
                onClick={() => setPicking((value) => !value)}
                disabled={submitting}
              >
                {picking ? 'Close the search' : 'Change lead'}
              </button>
              {leadChanged ? (
                <button
                  type="button"
                  className="tc-text-button"
                  onClick={() => chooseLead(currentLead)}
                  disabled={submitting}
                >
                  Keep the current lead
                </button>
              ) : null}
            </div>

            {picking ? (
              <div id={fieldId('lead-search')} className="tc-dialog__section">
                <input
                  ref={searchInput}
                  className="input"
                  type="search"
                  value={leadQuery}
                  placeholder="Customer name, reference or phone number"
                  aria-label="Search for the lead to move this follow-up to"
                  onChange={(event) => setLeadQuery(event.target.value)}
                />

                {leadSearching ? <Loader inline size="sm" label="Searching leads…" /> : null}
                {leadSearchError ? <p className="field__error">{leadSearchError}</p> : null}

                {!leadSearching && leadResults === null && !leadSearchError ? (
                  <p className="tc-dialog__note">
                    Type at least two characters. Archived leads are not listed: restore one
                    before moving a follow-up onto it.
                  </p>
                ) : null}

                {leadResults !== null && leadResults.items.length === 0 && !leadSearching ? (
                  <p className="tc-dialog__note">
                    No lead matches “{leadResults.query}”. Archived leads are not listed.
                  </p>
                ) : null}

                {leadResults !== null && leadResults.items.length > 0 ? (
                  <div
                    className="tc-pick-list"
                    role="radiogroup"
                    aria-label={`Leads matching ${leadResults.query}`}
                  >
                    {leadResults.items.map((item) => (
                      <label
                        key={item.id}
                        className="tc-pick-list__item"
                        data-selected={lead.id === item.id ? 'true' : undefined}
                      >
                        <input
                          type="radio"
                          name={fieldId('lead')}
                          checked={lead.id === item.id}
                          onChange={() => chooseLead(leadOfListItem(item))}
                        />
                        <span className="tc-pick-list__main">
                          <span className="tc-pick-list__name">
                            {item.customerName}
                            <LeadStatusBadge status={item.status} />
                            {CLOSED_STATUSES.includes(item.status) ? (
                              <Tag tone="warn">Closed</Tag>
                            ) : null}
                            {item.id === followUp.leadId ? <Tag>Current lead</Tag> : null}
                          </span>
                          <span className="tc-pick-list__meta">
                            {item.reference} · {item.phone} ·{' '}
                            {item.assignedToName ? `Owner: ${item.assignedToName}` : 'No owner'}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                ) : null}

                {leadResults !== null && leadResults.total > leadResults.items.length ? (
                  <p className="tc-dialog__note">
                    Showing {leadResults.items.length} of {leadResults.total}. Type more of the
                    name, reference or number to narrow it down.
                  </p>
                ) : null}
              </div>
            ) : null}

            {fieldError('leadId') ? <p className="field__error">{fieldError('leadId')}</p> : null}
          </div>

          {/* -------------------------------------------------------- employee */}
          <div
            className={`field${
              fieldError('assignedTo') || (!assigneeAssignable && assigneeId === followUp.assignedTo)
                ? ' field--invalid'
                : ''
            }`}
          >
            <label className="field__label" htmlFor={fieldId('employee')}>
              Employee
            </label>
            <select
              id={fieldId('employee')}
              className="select"
              value={assigneeId === null ? '' : String(assigneeId)}
              disabled={submitting}
              onChange={(event) => {
                setAssigneeId(event.target.value ? Number(event.target.value) : null);
                setServerErrors((errors) => withoutKey(errors, 'assignedTo'));
                setDuplicate(null);
              }}
            >
              {/*
                A holder who can no longer take calls stays visible as the current value —
                otherwise the select would show the first name in the list as if it were
                the current one — but cannot be chosen.
              */}
              {!currentAssignable ? (
                <option value={followUp.assignedTo === null ? '' : String(followUp.assignedTo)} disabled>
                  {followUp.assignedTo === null
                    ? 'Unassigned — choose someone'
                    : `${followUp.assignedToName ?? 'Former employee'} (deactivated)`}
                </option>
              ) : null}
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                  {employee.id === followUp.assignedTo ? ' (current)' : ''}
                </option>
              ))}
            </select>
            {fieldError('assignedTo') ? (
              <p className="field__error">{fieldError('assignedTo')}</p>
            ) : !assigneeAssignable ? (
              <p className="field__hint">
                {followUp.assignedTo === null
                  ? 'Nobody holds this follow-up. Choose who should make the call.'
                  : `${followUp.assignedToName ?? 'The current holder'} is deactivated. Choose who should make the call.`}
              </p>
            ) : null}
          </div>

          {/* --------------------------------------------------- date and time */}
          <div className="tc-form__grid">
            <div className={`field${dueError || fieldError('dueAt') || duplicate ? ' field--invalid' : ''}`}>
              <label className="field__label" htmlFor={fieldId('date')}>
                Date
              </label>
              <input
                id={fieldId('date')}
                className="input"
                type="date"
                min={todayIso()}
                value={date}
                disabled={submitting}
                onChange={(event) => {
                  setDate(event.target.value);
                  setServerErrors((errors) => withoutKey(errors, 'dueAt'));
                  setDuplicate(null);
                }}
              />
            </div>

            <div className={`field${dueError || fieldError('dueAt') || duplicate ? ' field--invalid' : ''}`}>
              <label className="field__label" htmlFor={fieldId('time')}>
                Time (IST)
              </label>
              <input
                id={fieldId('time')}
                className="input"
                type="time"
                step={300}
                value={time}
                disabled={submitting}
                onChange={(event) => {
                  setTime(event.target.value);
                  setServerErrors((errors) => withoutKey(errors, 'dueAt'));
                  setDuplicate(null);
                }}
              />
            </div>
          </div>

          <p className="tc-dialog__note">
            Times are India Standard Time (IST), whatever this computer&apos;s clock is set to.{' '}
            {timeChanged ? (
              <button
                type="button"
                className="tc-text-button"
                onClick={() => {
                  setDate(originalDate);
                  setTime(originalTime);
                  setServerErrors((errors) => withoutKey(errors, 'dueAt'));
                  setDuplicate(null);
                }}
                disabled={submitting}
              >
                Keep the current date and time
              </button>
            ) : (
              <span>Unchanged: the current date and time are kept.</span>
            )}
          </p>

          {dueError ? <p className="field__error">{dueError}</p> : null}
          {fieldError('dueAt') ? <p className="field__error">{fieldError('dueAt')}</p> : null}
          {duplicate ? (
            <div className="field__error" role="alert">
              <span>
                {duplicate}{' '}
                {onShowExisting ? (
                  <button
                    type="button"
                    className="tc-text-button"
                    onClick={() => onShowExisting({ id: lead.id, reference: lead.reference })}
                  >
                    Show the existing follow-up
                  </button>
                ) : null}
              </span>
            </div>
          ) : null}

          {/* ------------------------------------------------- lead ownership */}
          {transferApplies && assigneeAssignable ? (
            <div className="tc-choice-list">
              <div className="tc-choice">
                <label>
                  <input
                    type="checkbox"
                    checked={transferLead}
                    disabled={submitting}
                    onChange={(event) => {
                      setTransferTouched(true);
                      setTransferChoice(event.target.checked);
                    }}
                  />
                  <span>Also make {assigneeName} the owner of this lead</span>
                </label>
              </div>
              <p className="tc-dialog__note">
                {lead.ownerId === null
                  ? `${lead.customerName}'s lead has no owner.`
                  : ownerActive
                    ? `${lead.customerName}'s lead belongs to ${lead.ownerName ?? 'someone else'}.`
                    : `${lead.customerName}'s lead belongs to ${lead.ownerName ?? 'someone'}, who is deactivated.`}{' '}
                Transferring a lead also moves its other pending follow-ups to the new owner.
              </p>
            </div>
          ) : null}

          {/* ------------------------------------------------- note and reason */}
          <div className="tc-form__grid">
            <div className={`field${fieldError('note') ? ' field--invalid' : ''}`}>
              <label className="field__label" htmlFor={fieldId('note')}>
                New note (optional)
              </label>
              <textarea
                id={fieldId('note')}
                className="textarea tc-textarea--short"
                maxLength={1000}
                value={note}
                disabled={submitting}
                placeholder="Leave blank to keep the current note"
                onChange={(event) => setNote(event.target.value)}
              />
              {fieldError('note') ? <p className="field__error">{fieldError('note')}</p> : null}
            </div>

            <div className={`field${fieldError('reason') ? ' field--invalid' : ''}`}>
              <label className="field__label" htmlFor={fieldId('reason')}>
                Reason (optional)
              </label>
              <input
                id={fieldId('reason')}
                className="input"
                maxLength={255}
                value={reason}
                disabled={submitting}
                placeholder="e.g. Covering for a colleague on leave"
                onChange={(event) => setReason(event.target.value)}
              />
              {fieldError('reason') ? (
                <p className="field__error">{fieldError('reason')}</p>
              ) : (
                <p className="field__hint">Kept with the move in the audit log.</p>
              )}
            </div>
          </div>
        </section>

        <section className="tc-dialog__section" aria-labelledby={fieldId('summary')}>
          <h3 className="tc-dialog__section-title" id={fieldId('summary')}>
            What changes
          </h3>
          <div className="tc-change">
            <ChangeRow
              label="Date & time (IST)"
              from={formatDateTime(followUp.dueAt)}
              to={timeChanged && newDueIso !== null ? formatDateTime(newDueIso) : null}
            />
            <ChangeRow
              label="Employee"
              from={followUp.assignedToName ?? 'Unassigned'}
              to={assigneeChanged ? assigneeName : null}
            />
            <ChangeRow
              label="Lead"
              from={`${followUp.leadName} (${followUp.leadReference})`}
              to={leadChanged ? `${lead.customerName} (${lead.reference})` : null}
            />
            {transferLead ? (
              <ChangeRow label="Lead owner" from={lead.ownerName ?? 'Unassigned'} to={assigneeName} />
            ) : null}
          </div>
        </section>

        {advice.length > 0 ? (
          <ul className="tc-advice" aria-label="Before you move it">
            {advice.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="tc-dialog__foot">
        {!anythingChanged ? (
          <p className="tc-dialog__foot-note">
            Change the date and time, the lead or the employee to move it.
          </p>
        ) : null}
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={submitting}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void submit()}
          disabled={!canSubmit}
          aria-busy={submitting || undefined}
        >
          {submitting ? <ButtonSpinner /> : null}
          Move follow-up
        </button>
      </div>
    </>
  );
}

/** One line of "What changes". */
function ChangeRow({ label, from, to }: { label: string; from: string; to: string | null }) {
  return (
    <div className={to === null ? 'tc-change__row tc-change__row--same' : 'tc-change__row'}>
      <span className="tc-change__label">{label}</span>
      <span className="tc-change__values">
        <span className="tc-change__from">{from}</span>
        {to === null ? (
          <span className="tc-change__same">No change</span>
        ) : (
          <>
            <span className="sr-only">changes to</span>
            <span className="tc-change__arrow" aria-hidden="true">
              →
            </span>
            <span className="tc-change__to">{to}</span>
          </>
        )}
      </span>
    </div>
  );
}

function withoutKey(errors: Record<string, string>, key: string): Record<string, string> {
  if (!(key in errors)) return errors;
  const next = { ...errors };
  delete next[key];
  return next;
}

/**
 * The form in its own dialog, for the follow-ups list.
 *
 * Mounted only while a follow-up is being moved — the screen renders it conditionally,
 * keyed on the follow-up — so every opening starts from the follow-up as it is now.
 */
export function MoveFollowUpDialog({
  followUp,
  employees,
  initialAssignedTo,
  onClose,
  onMoved,
  onStale,
  onUnauthorized,
  onShowExisting,
}: {
  followUp: FollowUp;
  employees: Employee[];
  initialAssignedTo?: number;
  onClose: () => void;
  onMoved: (result: MoveFollowUpResult) => void;
  onStale: (message: string) => void;
  onUnauthorized: () => void;
  onShowExisting?: (lead: { id: number; reference: string }) => void;
}) {
  /*
   * Dialog re-runs its open effect — which focuses the panel — whenever `onClose` changes
   * identity. A screen that re-renders while the dialog is open (a list refresh landing)
   * would pull focus out of whatever field the admin was typing in. The latest handler
   * lives in a ref and Dialog gets one stable function.
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const close = useCallback(() => onCloseRef.current(), []);

  return (
    <Dialog
      open
      onClose={close}
      title="Move follow-up"
      label={`Move the follow-up for ${followUp.leadName}`}
      className="tc-dialog"
      dismissOnBackdrop={false}
    >
      <div className="tc-dialog__head">
        <p className="tc-dialog__eyebrow">Follow-up</p>
        <h2 className="tc-dialog__title">Move follow-up</h2>
        <p className="tc-dialog__sub">
          {followUp.leadName} · {followUp.leadReference}
        </p>
      </div>

      <MoveFollowUpForm
        followUp={followUp}
        employees={employees}
        initialAssignedTo={initialAssignedTo}
        onCancel={close}
        onMoved={onMoved}
        onStale={onStale}
        onUnauthorized={onUnauthorized}
        onShowExisting={onShowExisting}
      />
    </Dialog>
  );
}

/** The success line a screen shows after a move: "Moved: 08 Oct 2026, 02:30 pm IST · Mira · LD-…". */
export function describeMove(result: MoveFollowUpResult): string {
  if (!result.changed) return 'Nothing changed — the follow-up already had those details.';

  const { followUp } = result;
  const parts = [
    `${formatDateTime(followUp.dueAt)} IST`,
    followUp.assignedToName ?? 'Unassigned',
    `${followUp.leadName} (${followUp.leadReference})`,
  ];
  let message = `Moved: ${parts.join(' · ')}.`;
  if (result.leadTransferred) message += ' The lead was transferred with it.';
  if (result.changes.leadId && result.sourceLeadPendingFollowUps === 0) {
    message += ` ${result.changes.leadId.fromName} has no pending follow-up left.`;
  }
  return message;
}
