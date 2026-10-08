'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { CellActions, CellStack, DataTable } from '@/components/admin/DataTable';
import { ButtonSpinner, LoaderBlock, LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Dialog } from '@/components/ui/Dialog';
import { ApiError } from '@/lib/api';
import {
  EMPLOYEE_ROLE_LABELS,
  addDaysToIsoDate,
  formatCount,
  formatDateTime,
  istToIso,
  telecallingApi,
  todayIso,
  type DeactivationCheck,
  type Employee,
  type FollowUp,
  type HandoverSchedule,
  type HandoverSkipReason,
  type HandoverSkippedRow,
  type MoveFollowUpResult,
  type Paginated,
  type PendingFollowUpsDetails,
} from '@/lib/telecalling';
import { MoveFollowUpForm, describeMove } from './MoveFollowUpDialog';
import { NavLink } from './nav';
import { LeadStatusBadge, Pager, Tag, TableSkeleton } from './shared';

/**
 * Deactivating an employee, and moving their pending follow-ups (Req 9).
 *
 * The server refuses to deactivate anyone who still holds a pending follow-up — inside
 * one locked transaction, so nothing can be booked onto them in between — and this dialog
 * is the way through that refusal rather than around it. It shows what they hold (overdue,
 * due today, upcoming, and how many open leads), lists the follow-ups a page at a time,
 * and moves a selection or all of them to someone else, keeping or re-dating them. Once
 * nothing is pending, Deactivate is enabled. "Move all and deactivate" does both in one
 * transaction, so there is no window between the move and the switch-off at all.
 *
 * The list is server-paged (25 a page). "Select all" never collects ids: it sends the
 * handover with no `followUpIds`, which the server reads as "every pending follow-up this
 * employee holds" — a client cannot build that list without fetching every row.
 *
 * Opened in `move` mode by "Move follow-ups", the same dialog without the deactivation.
 * That works for an employee who is already deactivated, which is how follow-ups left on
 * former staff are cleared.
 *
 * Replaces the old window.confirm (deactivate) and window.prompt (an employee code typed
 * from a list of the current page only).
 */

export type DeactivateEmployeeMode = 'deactivate' | 'move';

const LIST_PAGE_SIZE = 25;

/** The server's limit on an explicit list of follow-up ids in one handover. */
const MAX_SELECTED_IDS = 500;

/**
 * The server's limit on one "move all" — no ids named — which is a single transaction
 * holding row locks, so it is bounded. Above it the server refuses, so the dialog says so
 * first and the admin moves them in ticked batches instead.
 */
const MAX_MOVE_ALL = 1000;

/** The server's own limit on a new due time, repeated to say so before sending. */
const MAX_AHEAD_MS = 2 * 365 * 86_400_000;

const SKIP_REASONS: Record<HandoverSkipReason, string> = {
  duplicate: 'The new employee already has a follow-up with this customer that day',
  not_pending: 'No longer pending',
  not_assigned_to_employee: 'Already with someone else',
  not_found: 'No longer exists',
};

const MANAGER_ONLY =
  'Moving another employee’s follow-ups needs a manager or administrator account.';
const ADMIN_ONLY = 'Only an administrator can deactivate employees.';

type Selection = { mode: 'all' } | { mode: 'some'; ids: ReadonlySet<number> };

type ScheduleMode = HandoverSchedule['mode'];

function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

function isAbort(caught: unknown): boolean {
  return caught instanceof DOMException && caught.name === 'AbortError';
}

/** The field errors this dialog shows under an input of its own. */
const PLACED_FIELDS: readonly string[] = ['toEmployeeId', 'schedule.dueAt', 'reason'];

/**
 * A 422's field errors, split into those shown under an input and the rest.
 *
 * The atomic deactivation nests the handover under `handover`, so its
 * `handover.schedule.dueAt` is the same input as the handover endpoint's `schedule.dueAt`.
 * Anything with no input here is spelt out in the banner rather than left behind "correct
 * the highlighted fields" with nothing highlighted.
 */
function placeFieldErrors(fieldErrors: Record<string, string>): {
  placed: Record<string, string>;
  unplaced: string[];
} {
  const placed: Record<string, string> = {};
  const unplaced: string[] = [];

  for (const [key, message] of Object.entries(fieldErrors)) {
    const local = key.startsWith('handover.') ? key.slice('handover.'.length) : key;
    if (!PLACED_FIELDS.includes(local)) unplaced.push(message);
    else if (!(local in placed)) placed[local] = message;
  }

  return { placed, unplaced };
}

export function DeactivateEmployeeDialog({
  employee,
  mode,
  onClose,
  onDeactivated,
  onUnauthorized,
}: {
  employee: Employee;
  mode: DeactivateEmployeeMode;
  /** Closed without deactivating. `summary` says what was moved meanwhile, if anything. */
  onClose: (summary: string | null) => void;
  onDeactivated: (updated: Employee, message: string) => void;
  onUnauthorized: () => void;
}) {
  const uid = useId();
  const fieldId = (name: string) => `${uid}-${name}`;

  /* ------------------------------------------------------------- state */

  const [check, setCheck] = useState<DeactivationCheck | null>(null);
  const [checking, setChecking] = useState(true);
  const [checkError, setCheckError] = useState<string | null>(null);

  const [list, setList] = useState<Paginated<FollowUp> | null>(null);
  const [listPage, setListPage] = useState(1);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  /** Active, approved staff: who follow-ups can go to. */
  const [staff, setStaff] = useState<Employee[] | null>(null);

  const [selection, setSelection] = useState<Selection>({ mode: 'all' });
  const [targetId, setTargetId] = useState<number | null>(null);
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('keep');
  const [scheduleDate, setScheduleDate] = useState(() => addDaysToIsoDate(todayIso(), 1));
  const [scheduleTime, setScheduleTime] = useState('10:00');
  const [transferLeads, setTransferLeads] = useState(false);
  const [reason, setReason] = useState('');

  const [working, setWorking] = useState<null | 'move' | 'deactivate' | 'atomic'>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /** The follow-ups the last handover left where they were, and why. */
  const [skipped, setSkipped] = useState<HandoverSkippedRow[]>([]);
  /** A skipped follow-up being moved on its own, with the move form in place of the body. */
  const [single, setSingle] = useState<FollowUp | null>(null);
  const [openingId, setOpeningId] = useState<number | null>(null);
  const [confirmCancelId, setConfirmCancelId] = useState<number | null>(null);
  const [cancellingId, setCancellingId] = useState<number | null>(null);

  /** How many follow-ups left this employee while the dialog was open, for the closing notice. */
  const movedAway = useRef(0);

  /* ----------------------------------------------------------- loading */

  const checkAbort = useRef<AbortController | null>(null);
  const listAbort = useRef<AbortController | null>(null);

  const loadCheck = useCallback(async () => {
    checkAbort.current?.abort();
    const controller = new AbortController();
    checkAbort.current = controller;

    setChecking(true);
    setCheckError(null);

    try {
      setCheck(await telecallingApi.deactivationCheck(employee.id, controller.signal));
    } catch (caught) {
      if (isAbort(caught)) return;
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setCheckError(
        caught instanceof ApiError && caught.status === 403
          ? MANAGER_ONLY
          : caught instanceof ApiError
            ? caught.message
            : `Could not check ${employee.name}’s follow-ups.`,
      );
    } finally {
      if (checkAbort.current === controller) setChecking(false);
    }
  }, [employee.id, employee.name, onUnauthorized]);

  const loadList = useCallback(
    async (page: number) => {
      listAbort.current?.abort();
      const controller = new AbortController();
      listAbort.current = controller;

      setListLoading(true);
      setListError(null);

      try {
        setList(
          await telecallingApi.listFollowUps(
            { scope: 'pending', assignedTo: employee.id, page, pageSize: LIST_PAGE_SIZE },
            controller.signal,
          ),
        );
      } catch (caught) {
        if (isAbort(caught)) return;
        if (caught instanceof ApiError && caught.status === 401) {
          onUnauthorized();
          return;
        }
        setListError(
          caught instanceof ApiError ? caught.message : 'Could not load the pending follow-ups.',
        );
      } finally {
        if (listAbort.current === controller) setListLoading(false);
      }
    },
    [employee.id, onUnauthorized],
  );

  useEffect(() => {
    void loadCheck();
  }, [loadCheck]);

  useEffect(() => {
    void loadList(listPage);
  }, [loadList, listPage]);

  useEffect(() => {
    const controller = new AbortController();

    telecallingApi
      .assignableEmployees(controller.signal)
      .then((rows) => setStaff(rows))
      .catch((caught: unknown) => {
        if (isAbort(caught)) return;
        if (caught instanceof ApiError && caught.status === 401) {
          onUnauthorized();
          return;
        }
        setStaff([]);
        setError('Could not load the employee list, so there is nobody to move follow-ups to. Close and try again.');
      });

    return () => controller.abort();
  }, [onUnauthorized]);

  useEffect(
    () => () => {
      checkAbort.current?.abort();
      listAbort.current?.abort();
    },
    [],
  );

  /** The counts and the page on screen, read again after anything that changes them. */
  const refresh = useCallback(() => {
    void loadCheck();
    void loadList(listPage);
  }, [loadCheck, loadList, listPage]);

  /* ----------------------------------------------------------- derived */

  const targets = useMemo(
    () => (staff ?? []).filter((candidate) => candidate.id !== employee.id),
    [staff, employee.id],
  );
  const target = targets.find((candidate) => candidate.id === targetId) ?? null;

  const pending = check?.pendingFollowUps.total ?? 0;
  const listTotal = list?.total ?? pending;
  const selectedCount = selection.mode === 'all' ? listTotal : selection.ids.size;

  /** What stands in the way other than the pending follow-ups this dialog deals with. */
  const otherBlockers = (check?.blockers ?? []).filter((blocker) => blocker.code !== 'pending_follow_ups');

  const scheduleIso = scheduleMode === 'keep' ? null : istToIso(scheduleDate, scheduleTime);
  let scheduleError: string | null = null;
  if (scheduleMode !== 'keep') {
    if (scheduleIso === null) scheduleError = 'Enter a real date and time.';
    else if (Date.parse(scheduleIso) <= Date.now()) scheduleError = 'Choose a time in the future.';
    else if (Date.parse(scheduleIso) >= Date.now() + MAX_AHEAD_MS) {
      scheduleError = 'That date is too far in the future.';
    }
  }

  const schedule: HandoverSchedule | null =
    scheduleMode === 'keep'
      ? { mode: 'keep' }
      : scheduleIso !== null && scheduleError === null
        ? { mode: scheduleMode, dueAt: scheduleIso }
        : null;

  const tooManyIds = selection.mode === 'some' && selection.ids.size > MAX_SELECTED_IDS;
  const tooManyForAll = selection.mode === 'all' && listTotal > MAX_MOVE_ALL;

  const moveBlockedBy: string | null =
    target === null
      ? 'Choose who to move them to.'
      : schedule === null
        ? 'Fix the date and time first.'
        : selectedCount === 0
          ? 'Tick at least one follow-up, or select them all.'
          : tooManyIds
            ? `Move at most ${MAX_SELECTED_IDS} ticked follow-ups at a time, or select them all.`
            : tooManyForAll
              ? `More than ${formatCount(MAX_MOVE_ALL)} are pending, too many to move in one go. Choose individually and move them a few pages at a time.`
              : null;

  const canMove = moveBlockedBy === null && working === null && pending > 0;
  const canDeactivate = mode === 'deactivate' && check !== null && check.canDeactivate && working === null;
  const canMoveAllAndDeactivate =
    mode === 'deactivate' &&
    check !== null &&
    pending > 0 &&
    pending <= MAX_MOVE_ALL &&
    otherBlockers.length === 0 &&
    target !== null &&
    schedule !== null &&
    working === null;

  /* ---------------------------------------------------------- closing */

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  /*
   * One stable function for Dialog, whose open effect — which moves focus to the panel —
   * re-runs whenever `onClose` changes identity.
   */
  const close = useCallback(() => {
    const moved = movedAway.current;
    onCloseRef.current(
      moved > 0
        ? `Moved ${plural(moved, 'pending follow-up')} away from ${employee.name}.`
        : null,
    );
  }, [employee.name]);

  /* ---------------------------------------------------------- actions */

  const resetMessages = () => {
    setError(null);
    setInfo(null);
    setFieldErrors({});
  };

  /** A refusal with no special handling: its field errors under their inputs, the rest above. */
  const showRefusal = (caught: ApiError) => {
    const { placed, unplaced } = placeFieldErrors(caught.fieldErrors);
    setFieldErrors(placed);
    setError(unplaced.length > 0 ? unplaced.join(' ') : caught.message);
  };

  const handoverBody = () => ({
    schedule: schedule ?? { mode: 'keep' as const },
    transferLeads,
    reason: reason.trim() || null,
  });

  const move = async () => {
    if (!canMove || target === null) return;

    resetMessages();
    setWorking('move');

    try {
      const result = await telecallingApi.handoverFollowUps(employee.id, {
        toEmployeeId: target.id,
        // "Select all" sends no ids at all: the server moves every pending follow-up the
        // employee holds, including any the list has not paged to.
        followUpIds: selection.mode === 'all' ? undefined : [...selection.ids],
        ...handoverBody(),
      });

      movedAway.current += result.moved;
      setSkipped(result.skipped);
      setSelection({ mode: 'all' });
      setInfo(
        [
          `Moved ${plural(result.moved, 'follow-up')} to ${target.name}.`,
          result.leadsTransferred > 0
            ? `${plural(result.leadsTransferred, 'lead')} transferred with them.`
            : '',
          result.skipped.length > 0
            ? `${plural(result.skipped.length, 'follow-up')} could not be moved — see below.`
            : '',
          result.remainingPending > 0
            ? `${plural(result.remainingPending, 'follow-up')} still pending with ${employee.name}.`
            : `Nothing is pending with ${employee.name} any more.`,
        ]
          .filter(Boolean)
          .join(' '),
      );
      refresh();
    } catch (caught) {
      if (!(caught instanceof ApiError)) {
        setError('Could not move the follow-ups.');
        return;
      }
      if (caught.status === 401) {
        onUnauthorized();
        return;
      }
      if (caught.status === 403) {
        setError(MANAGER_ONLY);
        return;
      }
      showRefusal(caught);
      // A 400 such as "That employee is deactivated." means the picture changed: re-read it.
      if (caught.status === 400 || caught.status === 409) refresh();
    } finally {
      setWorking(null);
    }
  };

  const failDeactivation = (caught: unknown, atomic: boolean) => {
    if (!(caught instanceof ApiError)) {
      setError(`Could not deactivate ${employee.name}.`);
      return;
    }
    if (caught.status === 401) {
      onUnauthorized();
      return;
    }
    if (caught.status === 403) {
      setError(ADMIN_ONLY);
      return;
    }
    if (caught.status === 409 && caught.code === 'pending_follow_ups') {
      /*
       * Something is still pending: a follow-up booked onto them since the counts were
       * read, or — moving all at once — a same-day duplicate the move had to skip. Either
       * way the transaction was rolled back whole.
       */
      const details = caught.details as Partial<PendingFollowUpsDetails> | undefined;
      if (Array.isArray(details?.skipped)) setSkipped(details.skipped);
      setError(
        `${caught.message} ${atomic ? 'Nothing was moved and nothing was changed.' : 'Nothing was changed.'}`,
      );
      refresh();
      return;
    }
    showRefusal(caught);
  };

  const deactivate = async () => {
    if (!canDeactivate) return;

    resetMessages();
    setWorking('deactivate');

    try {
      const result = await telecallingApi.deactivateEmployee(employee.id, {
        reason: reason.trim() || null,
      });
      onDeactivated(
        result.employee,
        `${employee.name} deactivated and signed out of the mobile app.${
          movedAway.current > 0 ? ` ${plural(movedAway.current, 'follow-up')} moved first.` : ''
        }`,
      );
    } catch (caught) {
      failDeactivation(caught, false);
    } finally {
      setWorking(null);
    }
  };

  const moveAllAndDeactivate = async () => {
    if (!canMoveAllAndDeactivate || target === null) return;

    resetMessages();
    setWorking('atomic');

    try {
      const result = await telecallingApi.deactivateEmployee(employee.id, {
        handover: { toEmployeeId: target.id, ...handoverBody() },
        reason: reason.trim() || null,
      });
      /*
       * Only this handover's count goes with the target's name: anything moved earlier in
       * the dialog may have gone to someone else, so it is counted on its own.
       */
      onDeactivated(
        result.employee,
        `${employee.name} deactivated and signed out of the mobile app. ${plural(
          result.handedOver,
          'follow-up',
        )} moved to ${target.name}${
          result.leadsTransferred > 0 ? `, with ${plural(result.leadsTransferred, 'lead')}` : ''
        }.${movedAway.current > 0 ? ` ${plural(movedAway.current, 'follow-up')} moved before that.` : ''}`,
      );
    } catch (caught) {
      failDeactivation(caught, true);
    } finally {
      setWorking(null);
    }
  };

  /** Opens the move form for one skipped follow-up, read fresh from the server first. */
  const openSingle = async (row: HandoverSkippedRow) => {
    if (row.leadId === null) return;

    resetMessages();
    setOpeningId(row.followUpId);

    try {
      // Bounded: one lead's pending follow-ups for one employee.
      const page = await telecallingApi.listFollowUps({
        scope: 'pending',
        assignedTo: employee.id,
        leadId: row.leadId,
        pageSize: LIST_PAGE_SIZE,
      });
      const found = page.items.find((item) => item.id === row.followUpId);

      if (!found) {
        setSkipped((rows) => rows.filter((item) => item.followUpId !== row.followUpId));
        setInfo(`That follow-up is no longer pending with ${employee.name}.`);
        refresh();
        return;
      }

      setSingle(found);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not open that follow-up.');
    } finally {
      setOpeningId(null);
    }
  };

  const singleMoved = (result: MoveFollowUpResult) => {
    const id = result.followUp.id;
    setSingle(null);
    setSkipped((rows) => rows.filter((item) => item.followUpId !== id));
    if (result.changed && result.followUp.assignedTo !== employee.id) movedAway.current += 1;
    setInfo(describeMove(result));
    refresh();
  };

  const singleStale = (message: string) => {
    setSingle(null);
    setInfo(`${message} The list has been refreshed.`);
    refresh();
  };

  const cancelDuplicate = async (row: HandoverSkippedRow) => {
    resetMessages();
    setCancellingId(row.followUpId);

    try {
      await telecallingApi.cancelFollowUp(row.followUpId);
      setSkipped((rows) => rows.filter((item) => item.followUpId !== row.followUpId));
      setConfirmCancelId(null);
      setInfo(
        `Cancelled the duplicate follow-up for ${row.leadName ?? 'that customer'}. It stays in the lead’s history as cancelled.`,
      );
      refresh();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not cancel that follow-up.');
    } finally {
      setCancellingId(null);
    }
  };

  /* ---------------------------------------------------------- selection */

  const pageIds = (list?.items ?? []).map((row) => row.id);
  const pageSelected =
    selection.mode === 'all' || (pageIds.length > 0 && pageIds.every((id) => selection.ids.has(id)));
  const pageSomeSelected =
    selection.mode === 'some' && pageIds.some((id) => selection.ids.has(id)) && !pageSelected;

  const toggleOne = (id: number, on: boolean) => {
    setSelection((current) => {
      if (current.mode === 'all') return current;
      const ids = new Set(current.ids);
      if (on) ids.add(id);
      else ids.delete(id);
      return { mode: 'some', ids };
    });
  };

  const togglePage = (on: boolean) => {
    setSelection((current) => {
      if (current.mode === 'all') return current;
      const ids = new Set(current.ids);
      for (const id of pageIds) {
        if (on) ids.add(id);
        else ids.delete(id);
      }
      return { mode: 'some', ids };
    });
  };

  /* ------------------------------------------------------------- render */

  const breakdown = check?.pendingFollowUps;
  const busy = working !== null;

  const scheduleInputs = (
    <span className="tc-choice__inputs">
      <input
        className="input input--sm"
        type="date"
        min={todayIso()}
        value={scheduleDate}
        aria-label="New date"
        disabled={busy}
        onChange={(event) => setScheduleDate(event.target.value)}
      />
      <input
        className="input input--sm"
        type="time"
        step={300}
        value={scheduleTime}
        aria-label="New time, IST"
        disabled={busy}
        onChange={(event) => setScheduleTime(event.target.value)}
      />
      <span className="tc-muted">IST</span>
    </span>
  );

  const reasonField = (
    <div className={`field${fieldErrors.reason ? ' field--invalid' : ''}`}>
      <label className="field__label" htmlFor={fieldId('reason')}>
        Reason (optional)
      </label>
      <input
        id={fieldId('reason')}
        className="input"
        maxLength={255}
        value={reason}
        disabled={busy}
        placeholder={mode === 'deactivate' ? 'e.g. Left the company' : 'e.g. On leave this month'}
        onChange={(event) => setReason(event.target.value)}
      />
      {fieldErrors.reason ? (
        <p className="field__error">{fieldErrors.reason}</p>
      ) : (
        <p className="field__hint">Kept in the audit log.</p>
      )}
    </div>
  );

  let footNote: string | null = null;
  if (mode === 'deactivate' && check !== null) {
    if (otherBlockers.length > 0) footNote = otherBlockers[0]?.message ?? null;
    else if (pending > 0) footNote = 'Deactivate is available once nothing is pending.';
  }

  return (
    <Dialog
      open
      onClose={close}
      title={mode === 'deactivate' ? `Deactivate ${employee.name}` : `Move ${employee.name}’s follow-ups`}
      className="tc-dialog tc-dialog--wide"
      dismissOnBackdrop={false}
    >
      <div className="tc-dialog__head">
        <p className="tc-dialog__eyebrow">{mode === 'deactivate' ? 'Deactivate employee' : 'Move follow-ups'}</p>
        <h2 className="tc-dialog__title">
          {mode === 'deactivate' ? `Deactivate ${employee.name}` : `Move ${employee.name}’s follow-ups`}
        </h2>
        <p className="tc-dialog__sub">
          {employee.employeeCode} · {EMPLOYEE_ROLE_LABELS[employee.role]}
          {employee.isActive ? '' : ' · deactivated'}
        </p>
      </div>

      {single ? (
        <MoveFollowUpForm
          key={single.id}
          followUp={single}
          employees={staff ?? []}
          heading={`Move the follow-up for ${single.leadName}`}
          cancelLabel="Back"
          onCancel={() => setSingle(null)}
          onMoved={singleMoved}
          onStale={singleStale}
          onUnauthorized={onUnauthorized}
        />
      ) : (
        <>
          <div className="tc-dialog__body">
            {error ? <FormAlert variant="error">{error}</FormAlert> : null}
            {info ? <FormAlert variant="success">{info}</FormAlert> : null}
            {checkError ? <FormAlert variant="error">{checkError}</FormAlert> : null}

            {check === null ? (
              checking ? (
                <LoaderBlock label={`Checking ${employee.name}’s follow-ups…`} minHeight="10rem" />
              ) : null
            ) : (
              <>
                {/* --------------------------------------------- what they hold */}
                <section className="tc-dialog__section" aria-labelledby={fieldId('holds')}>
                  <h3 className="tc-dialog__section-title" id={fieldId('holds')}>
                    {pending > 0
                      ? `${employee.name} has ${plural(pending, 'pending follow-up')}`
                      : `${employee.name} has no pending follow-ups`}
                  </h3>
                  {breakdown && pending > 0 ? (
                    <div className="tc-count-tags">
                      {breakdown.overdue > 0 ? (
                        <Tag tone="bad">{formatCount(breakdown.overdue)} overdue</Tag>
                      ) : null}
                      {breakdown.dueToday > 0 ? (
                        <Tag tone="warn">{formatCount(breakdown.dueToday)} due today</Tag>
                      ) : null}
                      {breakdown.upcoming > 0 ? (
                        <Tag>{formatCount(breakdown.upcoming)} upcoming</Tag>
                      ) : null}
                      {breakdown.earliestDueAt ? (
                        <span className="tc-muted">
                          Earliest due {formatDateTime(breakdown.earliestDueAt)}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  <p className="tc-dialog__note">
                    {check.openLeads > 0
                      ? `They also have ${plural(check.openLeads, 'open lead')}.`
                      : 'They have no open leads.'}
                    {breakdown && breakdown.onArchivedLeads > 0
                      ? ` ${plural(breakdown.onArchivedLeads, 'of the follow-ups is', 'of the follow-ups are')} on archived leads: move them like the rest, or cancel them.`
                      : ''}
                  </p>
                </section>

                {otherBlockers.length > 0 && mode === 'deactivate' ? (
                  <FormAlert variant="info">
                    {otherBlockers.map((blocker) => blocker.message).join(' ')}
                  </FormAlert>
                ) : null}

                {/* ---------------------------------------- skipped by a move */}
                {skipped.length > 0 ? (
                  <section className="tc-dialog__section" aria-labelledby={fieldId('skipped')}>
                    <h3 className="tc-dialog__section-title" id={fieldId('skipped')}>
                      Not moved
                    </h3>
                    <p className="tc-dialog__note">
                      These stayed with {employee.name}. Move each one somewhere else, or —
                      when it repeats a follow-up the new employee already has that day —
                      cancel it.
                    </p>
                    <DataTable
                      rows={skipped}
                      rowKey={(row) => row.followUpId}
                      rowBusy={(row) => cancellingId === row.followUpId || openingId === row.followUpId}
                      minWidth="44rem"
                      caption="Follow-ups the move left in place, with the reason"
                      columns={[
                        {
                          key: 'due',
                          header: 'Due',
                          width: '11rem',
                          nowrap: true,
                          render: (row) => formatDateTime(row.dueAt),
                        },
                        {
                          key: 'customer',
                          header: 'Customer',
                          width: '12rem',
                          render: (row) => row.leadName ?? '—',
                        },
                        {
                          key: 'reason',
                          header: 'Why',
                          render: (row) => (
                            <Tag tone={row.reason === 'duplicate' ? 'warn' : 'neutral'}>
                              {SKIP_REASONS[row.reason]}
                            </Tag>
                          ),
                        },
                        {
                          key: 'actions',
                          header: 'Actions',
                          align: 'end',
                          width: '15rem',
                          render: (row) =>
                            confirmCancelId === row.followUpId ? (
                              <CellActions>
                                <button
                                  type="button"
                                  className="btn btn--outline btn--sm"
                                  disabled={cancellingId !== null || busy}
                                  onClick={() => void cancelDuplicate(row)}
                                  aria-busy={cancellingId === row.followUpId || undefined}
                                >
                                  {cancellingId === row.followUpId ? <ButtonSpinner /> : null}
                                  Yes, cancel it
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--ghost btn--sm"
                                  disabled={cancellingId !== null}
                                  onClick={() => setConfirmCancelId(null)}
                                >
                                  Keep
                                </button>
                              </CellActions>
                            ) : (
                              <CellActions>
                                {row.leadId !== null && row.reason === 'duplicate' ? (
                                  <button
                                    type="button"
                                    className="btn btn--outline btn--sm"
                                    disabled={openingId !== null || staff === null || busy}
                                    onClick={() => void openSingle(row)}
                                    aria-busy={openingId === row.followUpId || undefined}
                                  >
                                    {openingId === row.followUpId ? <ButtonSpinner /> : null}
                                    Move…
                                  </button>
                                ) : null}
                                {row.reason === 'duplicate' ? (
                                  <button
                                    type="button"
                                    className="btn btn--ghost btn--sm"
                                    disabled={cancellingId !== null || busy}
                                    onClick={() => setConfirmCancelId(row.followUpId)}
                                  >
                                    Cancel as duplicate
                                  </button>
                                ) : (
                                  <span className="tc-muted">Nothing to do</span>
                                )}
                              </CellActions>
                            ),
                        },
                      ]}
                    />
                  </section>
                ) : null}

                {/* ------------------------------------------ pending, paged */}
                {pending > 0 || (list !== null && list.total > 0) ? (
                  <section className="tc-dialog__section" aria-labelledby={fieldId('pending')}>
                    <h3 className="tc-dialog__section-title" id={fieldId('pending')}>
                      Pending follow-ups
                    </h3>

                    <div className="tc-selection-bar" role="status">
                      {selection.mode === 'all' ? (
                        <>
                          <span>
                            All {plural(listTotal, 'pending follow-up')}{' '}
                            {listTotal === 1 ? 'is' : 'are'} selected
                            {list && list.totalPages > 1 ? ', on every page' : ''}.
                          </span>
                          <button
                            type="button"
                            className="tc-text-button"
                            disabled={busy}
                            onClick={() => setSelection({ mode: 'some', ids: new Set() })}
                          >
                            Choose individually
                          </button>
                        </>
                      ) : (
                        <>
                          <span>
                            {formatCount(selection.ids.size)} of {formatCount(listTotal)} selected.
                          </span>
                          <button
                            type="button"
                            className="tc-text-button"
                            disabled={busy}
                            onClick={() => setSelection({ mode: 'all' })}
                          >
                            Select all {formatCount(listTotal)} pending
                          </button>
                          {selection.ids.size > 0 ? (
                            <button
                              type="button"
                              className="tc-text-button"
                              disabled={busy}
                              onClick={() => setSelection({ mode: 'some', ids: new Set() })}
                            >
                              Clear the selection
                            </button>
                          ) : null}
                        </>
                      )}
                    </div>

                    {listError ? <FormAlert variant="error">{listError}</FormAlert> : null}

                    {list === null ? (
                      listLoading ? (
                        <TableSkeleton rows={4} />
                      ) : null
                    ) : (
                      <LoadingOverlay busy={listLoading}>
                        <DataTable
                          rows={list.items}
                          rowKey={(row) => row.id}
                          rowTone={(row) => (row.isOverdue ? 'bad' : undefined)}
                          minWidth="44rem"
                          caption={`${employee.name}'s pending follow-ups, one page at a time, with tick boxes to choose which to move`}
                          columns={[
                            {
                              key: 'tick',
                              header: (
                                <TickBox
                                  checked={pageSelected}
                                  indeterminate={pageSomeSelected}
                                  disabled={selection.mode === 'all' || busy || pageIds.length === 0}
                                  label="Tick every follow-up on this page"
                                  onChange={togglePage}
                                />
                              ),
                              width: '2.75rem',
                              render: (row) => (
                                <TickBox
                                  checked={selection.mode === 'all' || selection.ids.has(row.id)}
                                  disabled={selection.mode === 'all' || busy}
                                  label={`Move the follow-up for ${row.leadName}`}
                                  onChange={(on) => toggleOne(row.id, on)}
                                />
                              ),
                            },
                            {
                              key: 'due',
                              header: 'Due (IST)',
                              width: '11rem',
                              nowrap: true,
                              render: (row) => (
                                <CellStack
                                  primary={
                                    <span className={row.isOverdue ? 'tc-cell-bad' : undefined}>
                                      {formatDateTime(row.dueAt)}
                                    </span>
                                  }
                                >
                                  {row.isOverdue ? <Tag tone="bad">Overdue</Tag> : null}
                                </CellStack>
                              ),
                            },
                            {
                              key: 'customer',
                              header: 'Customer',
                              render: (row) => (
                                <CellStack primary={row.leadName} secondary={row.leadPhone}>
                                  <span className="tc-muted tc-mono">{row.leadReference}</span>
                                </CellStack>
                              ),
                            },
                            {
                              key: 'status',
                              header: 'Lead status',
                              width: '10rem',
                              render: (row) => <LeadStatusBadge status={row.leadStatus} />,
                            },
                            {
                              key: 'owner',
                              header: 'Lead owner',
                              width: '10rem',
                              render: (row) =>
                                row.leadAssignedTo === employee.id
                                  ? employee.name
                                  : (row.leadAssignedToName ?? 'Unassigned'),
                            },
                          ]}
                        />
                      </LoadingOverlay>
                    )}

                    {list && list.totalPages > 1 ? (
                      <Pager
                        page={list.page}
                        totalPages={list.totalPages}
                        total={list.total}
                        noun="pending follow-up"
                        busy={listLoading}
                        onChange={setListPage}
                      />
                    ) : null}
                  </section>
                ) : mode === 'move' ? (
                  <p className="tc-muted">
                    Nothing to move: {employee.name} holds no pending follow-ups.
                  </p>
                ) : null}

                {/* -------------------------------------------- where to */}
                {pending > 0 ? (
                  <section className="tc-dialog__section" aria-labelledby={fieldId('to')}>
                    <h3 className="tc-dialog__section-title" id={fieldId('to')}>
                      Move them to
                    </h3>

                    <div className="tc-form__grid">
                      <div className={`field${fieldErrors.toEmployeeId ? ' field--invalid' : ''}`}>
                        <label className="field__label" htmlFor={fieldId('target')}>
                          Employee
                        </label>
                        <select
                          id={fieldId('target')}
                          className="select"
                          value={targetId === null ? '' : String(targetId)}
                          disabled={busy || staff === null}
                          onChange={(event) =>
                            setTargetId(event.target.value ? Number(event.target.value) : null)
                          }
                        >
                          <option value="">
                            {staff !== null && targets.length === 0
                              ? 'No other active employee'
                              : 'Choose an employee'}
                          </option>
                          {targets.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.name} · {EMPLOYEE_ROLE_LABELS[candidate.role]}
                            </option>
                          ))}
                        </select>
                        {fieldErrors.toEmployeeId ? (
                          <p className="field__error">{fieldErrors.toEmployeeId}</p>
                        ) : null}
                      </div>

                      {reasonField}
                    </div>

                    <fieldset className="tc-choice-list" disabled={busy}>
                      <legend>When they fall due</legend>
                      <div className="tc-choice">
                        <label>
                          <input
                            type="radio"
                            name={fieldId('schedule')}
                            checked={scheduleMode === 'keep'}
                            onChange={() => setScheduleMode('keep')}
                          />
                          <span>Keep each follow-up’s date and time</span>
                        </label>
                      </div>
                      <div className="tc-choice">
                        <label>
                          <input
                            type="radio"
                            name={fieldId('schedule')}
                            checked={scheduleMode === 'overdue_to'}
                            onChange={() => setScheduleMode('overdue_to')}
                          />
                          <span>Move only the overdue ones to</span>
                        </label>
                        {scheduleMode === 'overdue_to' ? scheduleInputs : null}
                      </div>
                      <div className="tc-choice">
                        <label>
                          <input
                            type="radio"
                            name={fieldId('schedule')}
                            checked={scheduleMode === 'all_to'}
                            onChange={() => setScheduleMode('all_to')}
                          />
                          <span>Move all of them to</span>
                        </label>
                        {scheduleMode === 'all_to' ? scheduleInputs : null}
                      </div>
                      {scheduleMode !== 'keep' ? (
                        <p className="tc-dialog__note">
                          Times are India Standard Time (IST), whatever this computer&apos;s clock is
                          set to.
                        </p>
                      ) : null}
                      {scheduleError ? <p className="field__error">{scheduleError}</p> : null}
                      {fieldErrors['schedule.dueAt'] ? (
                        <p className="field__error">{fieldErrors['schedule.dueAt']}</p>
                      ) : null}
                    </fieldset>

                    <div className="tc-choice-list">
                      <div className="tc-choice">
                        <label>
                          <input
                            type="checkbox"
                            checked={transferLeads}
                            disabled={busy}
                            onChange={(event) => setTransferLeads(event.target.checked)}
                          />
                          <span>Also transfer the leads behind these follow-ups</span>
                        </label>
                      </div>
                      <p className="tc-dialog__note">
                        Only leads {employee.name} owns are transferred. Without it, the new
                        employee sees the follow-ups but cannot open those leads in the app. A
                        transferred lead takes all of its pending follow-ups with it.
                      </p>
                    </div>

                    <div className="tc-choice">
                      <button
                        type="button"
                        className={mode === 'move' ? 'btn btn--primary' : 'btn btn--outline'}
                        disabled={!canMove}
                        onClick={() => void move()}
                        aria-busy={working === 'move' || undefined}
                      >
                        {working === 'move' ? <ButtonSpinner /> : null}
                        {selection.mode === 'all'
                          ? `Move all ${plural(listTotal, 'follow-up')}`
                          : `Move ${plural(selection.ids.size, 'follow-up')}`}
                      </button>
                      {moveBlockedBy && working === null ? (
                        <span className="tc-muted">{moveBlockedBy}</span>
                      ) : null}
                    </div>
                  </section>
                ) : null}

                {/* ------------------------------------------- deactivation */}
                {mode === 'deactivate' ? (
                  <section className="tc-dialog__section" aria-labelledby={fieldId('off')}>
                    <h3 className="tc-dialog__section-title" id={fieldId('off')}>
                      What deactivating does
                    </h3>
                    <p className="tc-dialog__note">
                      {employee.name} is signed out of the mobile app at once and cannot receive
                      new leads or follow-ups.
                      {check.openLeads > 0 ? (
                        <>
                          {' '}
                          Their {plural(check.openLeads, 'open lead')}{' '}
                          {check.openLeads === 1 ? 'stays' : 'stay'} assigned to them until you
                          reassign {check.openLeads === 1 ? 'it' : 'them'}.{' '}
                          <NavLink section="leads" params={{ assignedTo: employee.id }}>
                            Reassign their leads
                          </NavLink>
                        </>
                      ) : null}
                    </p>
                    {pending === 0 ? reasonField : null}
                  </section>
                ) : null}
              </>
            )}
          </div>

          <div className="tc-dialog__foot">
            {footNote ? <p className="tc-dialog__foot-note">{footNote}</p> : null}

            <button type="button" className="btn btn--ghost" onClick={close} disabled={busy}>
              Close
            </button>

            {mode === 'deactivate' && pending > 0 && check !== null && otherBlockers.length === 0 ? (
              <button
                type="button"
                className="btn btn--primary"
                disabled={!canMoveAllAndDeactivate}
                onClick={() => void moveAllAndDeactivate()}
                aria-busy={working === 'atomic' || undefined}
                title={
                  target === null
                    ? 'Choose who to move them to first'
                    : pending > MAX_MOVE_ALL
                      ? 'Too many to move in one go: move them in batches first'
                      : undefined
                }
              >
                {working === 'atomic' ? <ButtonSpinner /> : null}
                {target ? `Move all to ${target.name} and deactivate` : 'Move all and deactivate'}
              </button>
            ) : null}

            {mode === 'deactivate' ? (
              <button
                type="button"
                className={pending > 0 ? 'btn btn--outline' : 'btn btn--primary'}
                disabled={!canDeactivate}
                onClick={() => void deactivate()}
                aria-busy={working === 'deactivate' || undefined}
              >
                {working === 'deactivate' ? <ButtonSpinner /> : null}
                Deactivate {employee.name}
              </button>
            ) : null}
          </div>
        </>
      )}
    </Dialog>
  );
}

/** A tick box with a third, "some on this page" state, which only script can set. */
function TickBox({
  checked,
  indeterminate = false,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}
