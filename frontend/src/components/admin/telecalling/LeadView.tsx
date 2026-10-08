'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ButtonSpinner, LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon, type IconName } from '@/components/ui/Icon';
import { ApiError } from '@/lib/api';
import {
  CALL_OUTCOME_LABELS,
  CALL_SOURCE_LABELS,
  LEAD_VIEW_PAGE_SIZE,
  NOTE_KIND_LABELS,
  formatCount,
  formatDateTime,
  formatDayHeading,
  formatDuration,
  formatTime,
  humanise,
  istDayKey,
  telecallingApi,
  todayIso,
  type ActivityEntry,
  type CallHistoryEntry,
  type FollowUp,
  type LeadCallSummary,
  type LeadDetailLead,
  type LeadDetailResponse,
  type LeadNote,
  type Paginated,
} from '@/lib/telecalling';
import { useTelecallingNav, type LeadFocus } from './nav';
import {
  EmptyPanel,
  LeadStatusBadge,
  Pager,
  StatCard,
  StatGrid,
  StatGridSkeleton,
  TableSkeleton,
  Tag,
} from './shared';

/**
 * Lead details, shown in place of the section's panel while `?lead=` is set.
 *
 * Everything known about one customer on one page: who they are and who owns them, what
 * the calls add up to, every call with what was said and decided on it, the follow-ups,
 * the notes, and the lead's own history. Read-only — the lists are where work is done;
 * this is where a manager reads a lead before deciding what that work should be.
 *
 * Nothing here loads a whole history. The first request brings the lead, its figures and
 * the first page of each history; every card then turns its own pages, and a page turn
 * refetches only that card, dimmed in place, while the rest of the page stays put. Figures
 * (the call stats, the counts in the card headings) come from the server's aggregates, so
 * they describe the whole lead whichever pages are showing.
 *
 * Everything else — which lead, how to close it, where it was opened from — comes from
 * `useTelecallingNav()`, so the shell renders it with the same one prop as every panel.
 */

type LeadViewProps = {
  /** Called when a request comes back 401, exactly as every panel's is. */
  onUnauthorized: () => void;
};

type ViewState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }
  | { kind: 'notFound' };

/** Decides what a failed card request shows: a message, or null when it was handled. */
type HistoryErrorHandler = (caught: unknown) => string | null;

/** The card each `openLead` focus scrolls to. */
const FOCUS_TARGETS: Record<LeadFocus, string> = {
  notes: 'tc-lead-notes',
  calls: 'tc-lead-calls',
  followups: 'tc-lead-followups',
};

function callElementId(callId: number): string {
  return `tc-lead-call-${callId}`;
}

function isAbort(caught: unknown): boolean {
  return caught instanceof DOMException && caught.name === 'AbortError';
}

function scrollBehaviour(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

/** "1 call", "3 calls". */
function plural(count: number, noun: string, nounPlural = `${noun}s`): string {
  return `${formatCount(count)} ${count === 1 ? noun : nounPlural}`;
}

/**
 * Groups a newest-first list by IST calendar day, newest day first.
 *
 * By the IST day, never `iso.slice(0, 10)`: that is the UTC day, and it would file every
 * call made between midnight and 05:30 under the day before. Grouping covers the page
 * that is showing — a day that runs across two pages is headed on both.
 */
function groupByIstDay<T>(items: T[], at: (item: T) => string): { day: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const day = istDayKey(at(item));
    const group = groups.get(day);
    if (group) group.push(item);
    else groups.set(day, [item]);
  }
  return [...groups].map(([day, dayItems]) => ({ day, items: dayItems }));
}

/**
 * The last nine digits of a number — the same match the server uses between a call and a
 * lead — so "+91 98765 43210" and "098765 43210" are one number.
 */
function phoneMatchKey(value: string | null): string {
  return (value ?? '').replace(/\D/g, '').slice(-9);
}

function isPast(iso: string | null): boolean {
  return iso !== null && new Date(iso).getTime() < Date.now();
}

/** Activity types, as a word or two above each line. A type not listed shows no label. */
const ACTIVITY_LABELS: Record<string, string> = {
  lead_created: 'Created',
  lead_updated: 'Edited',
  lead_assigned: 'Assigned',
  lead_reassigned: 'Reassigned',
  lead_unassigned: 'Unassigned',
  status_changed: 'Status',
  call_logged: 'Call',
  recording_attached: 'Recording',
  note_added: 'Note',
  follow_up_created: 'Follow-up booked',
  follow_up_completed: 'Follow-up completed',
  follow_up_rescheduled: 'Follow-up rescheduled',
  follow_up_cancelled: 'Follow-up cancelled',
  follow_up_moved: 'Follow-up moved',
  follow_up_reassigned: 'Follow-up reassigned',
  lead_archived: 'Archived',
  lead_restored: 'Restored',
};

/* -------------------------------------------------------------------------- */
/* One card's pages                                                            */
/* -------------------------------------------------------------------------- */

type PagedHistory<T> = {
  data: Paginated<T>;
  loading: boolean;
  error: string | null;
  goTo: (page: number) => void;
  retry: () => void;
  /** The card's element, brought back into view when a page turn lands below its top. */
  cardRef: RefObject<HTMLElement | null>;
};

/**
 * One history card's paging: starts from the page `leadDetail` brought, fetches others on
 * demand, and keeps the page on screen — dimmed — while the next one loads.
 *
 * A card is remounted (keyed) whenever the whole lead is reloaded, which is how it picks
 * up the fresh first page; within one load it never resets itself.
 */
function usePagedHistory<T>(
  initial: Paginated<T>,
  fetchPage: (page: number, signal: AbortSignal) => Promise<Paginated<T>>,
  handleError: HistoryErrorHandler,
): PagedHistory<T> {
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<{ message: string; page: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const goTo = useCallback(
    (page: number) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setFailure(null);

      fetchPage(page, controller.signal)
        .then((next) => {
          setData(next);
          // The pager sits at the bottom of the card. When the reader has scrolled down to
          // it, the new page is shown from its start rather than from its end.
          const card = cardRef.current;
          if (card && card.getBoundingClientRect().top < 0) {
            card.scrollIntoView({ block: 'start', behavior: scrollBehaviour() });
          }
        })
        .catch((caught: unknown) => {
          if (isAbort(caught)) return;
          const message = handleError(caught);
          if (message !== null) setFailure({ message, page });
        })
        .finally(() => {
          if (abortRef.current === controller) setLoading(false);
        });
    },
    [fetchPage, handleError],
  );

  const retry = useCallback(() => {
    if (failure) goTo(failure.page);
  }, [failure, goTo]);

  return { data, loading, error: failure?.message ?? null, goTo, retry, cardRef };
}

/* -------------------------------------------------------------------------- */
/* Card furniture                                                              */
/* -------------------------------------------------------------------------- */

function LeadCard({
  id,
  title,
  count,
  sectionRef,
  children,
}: {
  id: string;
  title: string;
  /** The whole history's size, not the page's. */
  count?: number;
  sectionRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  return (
    <section id={id} ref={sectionRef} className="tc-card tc-lead-card" aria-labelledby={`${id}-title`}>
      <div className="tc-lead-card__head">
        {/* Focusable so a link that opens the lead at this card can put the reader here. */}
        <h3 id={`${id}-title`} className="tc-lead-card__title" tabIndex={-1}>
          {title}
        </h3>
        {count !== undefined ? <span className="tc-lead-card__count">{formatCount(count)}</span> : null}
      </div>
      {children}
    </section>
  );
}

function CardEmpty({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <div className="tc-empty tc-lead-card__empty">
      <span className="tc-empty__icon" aria-hidden="true">
        <Icon name={icon} size={22} />
      </span>
      <p className="tc-empty__title">{title}</p>
      <p className="tc-empty__body">{body}</p>
    </div>
  );
}

/** A page that failed to load. The page before it stays on screen underneath. */
function CardError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="tc-lead-card__error">
      <FormAlert variant="error">{message}</FormAlert>
      <button type="button" className="btn btn--outline btn--sm" onClick={onRetry}>
        <Icon name="refresh" size={15} />
        Try again
      </button>
    </div>
  );
}

/** A button that reads as a link, for "View call" next to a note or a follow-up. */
function ViewCallButton({ callId, onShowCall }: { callId: number; onShowCall: (callId: number) => void }) {
  return (
    <button type="button" className="tc-link-button" onClick={() => onShowCall(callId)}>
      View call
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */

const NONE = '—';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="admin-detail__row">
      <dt className="admin-detail__label">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function PhoneLink({ value }: { value: string }) {
  return (
    <a className="tc-link" href={`tel:${value.replace(/[^\d+]/g, '')}`}>
      {value}
    </a>
  );
}

function LeadSummary({ lead, lastCallAt }: { lead: LeadDetailLead; lastCallAt: string | null }) {
  const assignedSince = lead.assignedAt
    ? ` since ${formatDateTime(lead.assignedAt)}${lead.assignedByName ? `, by ${lead.assignedByName}` : ''}`
    : '';

  return (
    <section className="tc-card tc-lead-card" aria-labelledby="tc-lead-summary-title">
      <div className="tc-lead-card__head">
        <h3 id="tc-lead-summary-title" className="tc-lead-card__title">
          Details
        </h3>
      </div>

      <dl className="admin-detail tc-lead-facts">
        <Fact label="Phone">
          <PhoneLink value={lead.phone} />
        </Fact>
        <Fact label="Alternate phone">
          {lead.alternatePhone ? <PhoneLink value={lead.alternatePhone} /> : NONE}
        </Fact>
        <Fact label="Email">
          {lead.email ? (
            <a className="tc-link" href={`mailto:${lead.email}`}>
              {lead.email}
            </a>
          ) : (
            NONE
          )}
        </Fact>
        <Fact label="City">{lead.city ?? NONE}</Fact>
        <Fact label="Address">
          {lead.address ? <span className="tc-prewrap">{lead.address}</span> : NONE}
        </Fact>
        <Fact label="Interested in">{lead.productInterest ?? NONE}</Fact>
        <Fact label="Source">{humanise(lead.source)}</Fact>
        <Fact label="Assigned to">
          {lead.assignedToName ? (
            <>
              {lead.assignedToName}
              {assignedSince ? <span className="tc-muted">{assignedSince}</span> : null}
            </>
          ) : (
            'Unassigned'
          )}
        </Fact>
        <Fact label="Created">
          {formatDateTime(lead.createdAt)}
          {lead.createdByName ? <span className="tc-muted"> by {lead.createdByName}</span> : null}
        </Fact>
        {/*
          Two different questions. "Last contacted" is the last call that was answered —
          the last time anyone actually spoke to them; "last call attempt" counts the
          unanswered ones too, so a lead rung daily without success does not look idle.
        */}
        <Fact label="Last contacted">{formatDateTime(lead.lastContactedAt)}</Fact>
        <Fact label="Last call attempt">{formatDateTime(lastCallAt)}</Fact>
        <Fact label="Next follow-up">
          {formatDateTime(lead.nextFollowUpAt)}
          {isPast(lead.nextFollowUpAt) ? (
            <>
              {' '}
              <Tag tone="bad">Overdue</Tag>
            </>
          ) : null}
        </Fact>
        {lead.convertedAt ? <Fact label="Converted">{formatDateTime(lead.convertedAt)}</Fact> : null}
        <Fact label="Last updated">{formatDateTime(lead.updatedAt)}</Fact>
        {lead.hasAttachment ? (
          <Fact label="Paper lead">
            {/*
              A direct link carrying the session cookie, like a recording: the photo is a
              file for the browser to show, not data for this screen. A new tab, so a
              refused request can never replace the admin with an error page.
            */}
            <a
              className="tc-link tc-lead-facts__external"
              href={telecallingApi.leadAttachmentUrl(lead.id)}
              target="_blank"
              rel="noopener"
            >
              View the photo
              <Icon name="external" size={14} />
            </a>
          </Fact>
        ) : null}
        {lead.enquiryId !== null ? <Fact label="Website enquiry">#{lead.enquiryId}</Fact> : null}
      </dl>

      <div className="tc-lead-requirement">
        <h4 className="tc-lead-requirement__title">Requirement / notes</h4>
        {lead.summaryNote ? (
          <p className="tc-prewrap">{lead.summaryNote}</p>
        ) : (
          <p className="tc-muted">Nothing written when the lead was taken down.</p>
        )}
      </div>
    </section>
  );
}

function CallFigures({ summary }: { summary: LeadCallSummary }) {
  const answerRate = summary.total > 0 ? Math.round((summary.answered / summary.total) * 100) : null;

  return (
    <section className="tc-lead-view__figures" aria-label="Call figures">
      <StatGrid>
        <StatCard
          icon="phone"
          value={formatCount(summary.total)}
          label="Calls"
          hint={`${formatCount(summary.outgoing)} outgoing · ${formatCount(summary.incoming)} incoming`}
        />
        <StatCard
          tone="good"
          value={formatCount(summary.answered)}
          label="Answered"
          hint={answerRate !== null ? `${answerRate}% of calls` : undefined}
        />
        <StatCard tone="warn" value={formatCount(summary.unanswered)} label="Not answered" />
        <StatCard value={formatDuration(summary.talkTimeSeconds)} label="Talk time" />
        <StatCard
          tone={summary.pendingCallbacks > 0 ? 'bad' : 'default'}
          value={formatCount(summary.pendingCallbacks)}
          label="Callbacks pending"
          hint="Unanswered calls nobody has returned"
        />
      </StatGrid>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Call history                                                                */
/* -------------------------------------------------------------------------- */

function FollowUpStateTag({ followUp }: { followUp: FollowUp }) {
  if (followUp.state === 'completed') return <Tag tone="good">Completed</Tag>;
  if (followUp.state === 'cancelled') return <Tag>Cancelled</Tag>;
  if (followUp.isOverdue) return <Tag tone="bad">Overdue</Tag>;
  if (istDayKey(followUp.dueAt) === todayIso()) return <Tag tone="warn">Due today</Tag>;
  return <Tag tone="progress">Upcoming</Tag>;
}

function CallItem({
  call,
  lead,
  canPlay,
  playing,
  highlighted,
  onPlay,
}: {
  call: CallHistoryEntry;
  lead: LeadDetailLead;
  canPlay: boolean;
  playing: boolean;
  /** Just reached through "View call". */
  highlighted: boolean;
  onPlay: () => void;
}) {
  const answered = call.outcome === 'answered';
  // The callback queue's own rule, as the "Callbacks pending" figure counts it: an
  // incoming call nobody verified as reaching the company SIM is in no queue, so it is
  // not marked as owed either — the tag and the figure above always agree.
  const callbackPending =
    !answered && !call.followedUp && (call.direction === 'outgoing' || call.simMatch !== null);
  const tone = answered ? ' tc-timeline__item--good' : callbackPending ? ' tc-timeline__item--bad' : '';

  // The number is worth showing only when it is not the lead's own: a call matched on the
  // alternate number, or a colleague's line.
  const callKey = phoneMatchKey(call.phone);
  const otherNumber =
    callKey !== '' && callKey !== phoneMatchKey(lead.phone) && callKey !== phoneMatchKey(lead.alternatePhone);

  return (
    <li
      id={callElementId(call.id)}
      tabIndex={-1}
      className={`tc-timeline__item${tone}${highlighted ? ' tc-timeline__item--highlight' : ''}`}
    >
      <time className="tc-timeline__time" dateTime={call.startedAt}>
        {formatTime(call.startedAt)}
      </time>

      <div className="tc-timeline__body">
        <div className="tc-timeline__line">
          <span className="tc-timeline__lead-in">
            {call.direction === 'incoming' ? 'Incoming' : 'Outgoing'}
          </span>
          <Tag tone={answered ? 'good' : 'neutral'}>{CALL_OUTCOME_LABELS[call.outcome]}</Tag>
          {call.durationSeconds > 0 ? <span>{formatDuration(call.durationSeconds)}</span> : null}
          <span className="tc-muted">{call.userName ?? 'Former employee'}</span>
        </div>

        <div className="tc-timeline__line">
          {/*
            How the figures were captured changes how far a duration can be trusted —
            measured from the call log, or remembered and typed in afterwards.
          */}
          <Tag tone={call.source === 'manual' ? 'neutral' : 'good'}>{CALL_SOURCE_LABELS[call.source]}</Tag>
          {call.channel === 'cloud' ? <Tag>Cloud</Tag> : null}
          {callbackPending ? <Tag tone="bad">Callback pending</Tag> : null}
          {call.direction === 'incoming' ? (
            call.recordedAt ? (
              <Tag tone="good">Written up</Tag>
            ) : (
              <Tag tone="warn">Not written up</Tag>
            )
          ) : null}
          {call.hasRecording ? <Tag tone="progress">Recorded</Tag> : null}
          {canPlay && call.recordingId !== null && !playing ? (
            <button type="button" className="btn btn--outline btn--sm tc-timeline__play" onClick={onPlay}>
              <Icon name="phone" size={14} />
              Play recording
            </button>
          ) : null}
        </div>

        {otherNumber ? (
          <p className="tc-muted">
            {call.direction === 'incoming' ? 'Called from' : 'Number dialled'}:{' '}
            <span className="tc-timeline__number">{call.phone}</span>
          </p>
        ) : null}

        {playing && call.recordingId !== null ? (
          /*
           * Mounted only once asked for. Each request for the audio writes an access entry
           * to the audit log server-side, so a page of calls must not fetch twenty of them
           * just by being scrolled past.
           */
          <audio
            className="tc-timeline__audio"
            controls
            autoPlay
            preload="none"
            src={telecallingApi.recordingAudioUrl(call.recordingId)}
          />
        ) : null}

        {call.statusChange ? (
          <p className="tc-timeline__status">
            <span>Status</span>
            <LeadStatusBadge status={call.statusChange.from} />
            <span aria-hidden="true">→</span>
            <span className="sr-only">to</span>
            <LeadStatusBadge status={call.statusChange.to} />
            {call.statusChange.userName ? (
              <span className="tc-muted">by {call.statusChange.userName}</span>
            ) : null}
          </p>
        ) : null}

        {call.notes.map((note) => (
          <div key={note.id} className="tc-timeline__note">
            <p className="tc-prewrap">{note.body}</p>
            <p className="tc-timeline__note-meta">
              {[note.userName, formatDateTime(note.createdAt)].filter(Boolean).join(' · ')}
            </p>
          </div>
        ))}

        {call.followUps.map((followUp) => (
          <div key={followUp.id} className="tc-timeline__followup">
            <p className="tc-timeline__line">
              <Icon name="clock" size={14} />
              <span>
                Follow-up booked for <strong>{formatDateTime(followUp.dueAt)}</strong>
              </span>
              <FollowUpStateTag followUp={followUp} />
            </p>
            {followUp.assignedToName ? <p className="tc-muted">For {followUp.assignedToName}</p> : null}
            {followUp.note ? <p className="tc-prewrap">{followUp.note}</p> : null}
          </div>
        ))}
      </div>
    </li>
  );
}

function CallsCard({
  leadId,
  lead,
  initial,
  canPlayRecordings,
  highlightedCallId,
  onError,
  onVisibleCallsChange,
}: {
  leadId: number;
  lead: LeadDetailLead;
  initial: Paginated<CallHistoryEntry>;
  canPlayRecordings: boolean;
  highlightedCallId: number | null;
  onError: HistoryErrorHandler;
  onVisibleCallsChange: (callIds: number[]) => void;
}) {
  const fetchPage = useCallback(
    (page: number, signal: AbortSignal) =>
      telecallingApi.leadCalls(leadId, { page, pageSize: LEAD_VIEW_PAGE_SIZE }, signal),
    [leadId],
  );
  const { data, loading, error, goTo, retry, cardRef } = usePagedHistory(initial, fetchPage, onError);
  const [playingId, setPlayingId] = useState<number | null>(null);

  // Notes and follow-ups elsewhere on the page offer "View call" only for the calls on
  // the page this card is showing — the only ones there is anything to scroll to.
  useEffect(() => {
    onVisibleCallsChange(data.items.map((call) => call.id));
  }, [data, onVisibleCallsChange]);

  const groups = useMemo(() => groupByIstDay(data.items, (call) => call.startedAt), [data]);

  return (
    <LeadCard id={FOCUS_TARGETS.calls} title="Call history" count={data.total} sectionRef={cardRef}>
      {error ? <CardError message={error} onRetry={retry} /> : null}

      {data.total === 0 ? (
        <CardEmpty
          icon="phone"
          title="No calls yet"
          body="Calls made to this customer, or received from them, appear here as they are logged."
        />
      ) : (
        <>
          <LoadingOverlay busy={loading}>
            <div className="tc-timeline">
              {groups.map((group) => {
                const talk = group.items.reduce(
                  (sum, call) => sum + (call.outcome === 'answered' ? call.durationSeconds : 0),
                  0,
                );
                return (
                  <section key={group.day} className="tc-timeline__day">
                    <h4 className="tc-timeline__day-head">
                      {formatDayHeading(group.day)}
                      <span className="tc-timeline__day-meta">
                        {' · '}
                        {plural(group.items.length, 'call')}
                        {talk > 0 ? ` · ${formatDuration(talk)} talk time` : ''}
                      </span>
                    </h4>
                    <ol className="tc-timeline__list">
                      {group.items.map((call) => (
                        <CallItem
                          key={call.id}
                          call={call}
                          lead={lead}
                          canPlay={canPlayRecordings}
                          playing={playingId === call.id}
                          highlighted={highlightedCallId === call.id}
                          onPlay={() => setPlayingId(call.id)}
                        />
                      ))}
                    </ol>
                  </section>
                );
              })}
            </div>
          </LoadingOverlay>

          <Pager
            page={data.page}
            totalPages={data.totalPages}
            total={data.total}
            noun="call"
            busy={loading}
            onChange={goTo}
          />
        </>
      )}
    </LeadCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Follow-ups                                                                  */
/* -------------------------------------------------------------------------- */

function FollowUpItem({
  followUp,
  callVisible,
  onShowCall,
}: {
  followUp: FollowUp;
  callVisible: boolean;
  onShowCall: (callId: number) => void;
}) {
  const moved = followUp.rescheduleCount;

  return (
    <li className="tc-lead-followup">
      <div className="tc-lead-followup__line">
        <strong>{formatDateTime(followUp.dueAt)}</strong>
        <FollowUpStateTag followUp={followUp} />
      </div>
      <p className="tc-muted">
        For {followUp.assignedToName ?? 'nobody yet'}
        {moved > 0 ? ` · Moved ${moved === 1 ? 'once' : `${formatCount(moved)} times`}` : ''}
      </p>
      {followUp.note ? <p className="tc-prewrap">{followUp.note}</p> : null}
      {followUp.state === 'completed' ? (
        <p className="tc-muted">
          Completed {formatDateTime(followUp.completedAt)}
          {followUp.completedByName ? ` by ${followUp.completedByName}` : ''}
        </p>
      ) : null}
      {followUp.outcomeNote ? (
        <p className="tc-prewrap tc-lead-followup__outcome">{followUp.outcomeNote}</p>
      ) : null}
      {followUp.callId !== null ? (
        <p className="tc-lead-followup__call">
          <span className="tc-muted">Booked on a call</span>
          {callVisible ? <ViewCallButton callId={followUp.callId} onShowCall={onShowCall} /> : null}
        </p>
      ) : null}
    </li>
  );
}

function FollowUpGroup({
  title,
  items,
  visibleCallIds,
  onShowCall,
}: {
  title: string;
  items: FollowUp[];
  visibleCallIds: ReadonlySet<number>;
  onShowCall: (callId: number) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div className="tc-lead-followups__group">
      <h4 className="tc-lead-followups__title">
        {title} <span className="tc-lead-followups__count">{formatCount(items.length)}</span>
      </h4>
      <ul className="tc-lead-followups__list">
        {items.map((followUp) => (
          <FollowUpItem
            key={followUp.id}
            followUp={followUp}
            callVisible={followUp.callId !== null && visibleCallIds.has(followUp.callId)}
            onShowCall={onShowCall}
          />
        ))}
      </ul>
    </div>
  );
}

function FollowUpsCard({
  leadId,
  pending,
  initialClosed,
  pendingCount,
  visibleCallIds,
  onShowCall,
  onError,
}: {
  leadId: number;
  pending: FollowUp[];
  initialClosed: Paginated<FollowUp>;
  /** Every pending follow-up on the lead — more than `pending` holds once the cap is hit. */
  pendingCount: number;
  visibleCallIds: ReadonlySet<number>;
  onShowCall: (callId: number) => void;
  onError: HistoryErrorHandler;
}) {
  const fetchPage = useCallback(
    (page: number, signal: AbortSignal) =>
      telecallingApi.leadClosedFollowUps(leadId, { page, pageSize: LEAD_VIEW_PAGE_SIZE }, signal),
    [leadId],
  );
  const { data, loading, error, goTo, retry, cardRef } = usePagedHistory(initialClosed, fetchPage, onError);

  const today = todayIso();
  const overdue = pending.filter((followUp) => followUp.isOverdue);
  const dueToday = pending.filter((followUp) => !followUp.isOverdue && istDayKey(followUp.dueAt) === today);
  const upcoming = pending.filter((followUp) => !followUp.isOverdue && istDayKey(followUp.dueAt) !== today);
  const completed = data.items.filter((followUp) => followUp.state === 'completed');
  const cancelled = data.items.filter((followUp) => followUp.state === 'cancelled');

  /*
   * The pending list arrives whole, but the server stops at 100. The lead's true pending
   * count says whether it did, so a cut list is labelled as one rather than passed off as
   * all.
   */
  const pendingTotal = Math.max(pending.length, Number.isFinite(pendingCount) ? pendingCount : 0);
  const total = pendingTotal + data.total;

  return (
    <LeadCard id={FOCUS_TARGETS.followups} title="Follow-ups" count={total} sectionRef={cardRef}>
      {error ? <CardError message={error} onRetry={retry} /> : null}

      {total === 0 ? (
        <CardEmpty
          icon="clock"
          title="No follow-ups"
          body="Follow-ups booked on this lead, from a call or by a manager, appear here."
        />
      ) : (
        <>
          <div className="tc-lead-followups">
            {pending.length === 0 ? <p className="tc-muted">Nothing pending.</p> : null}
            <FollowUpGroup title="Overdue" items={overdue} visibleCallIds={visibleCallIds} onShowCall={onShowCall} />
            <FollowUpGroup title="Due today" items={dueToday} visibleCallIds={visibleCallIds} onShowCall={onShowCall} />
            <FollowUpGroup title="Upcoming" items={upcoming} visibleCallIds={visibleCallIds} onShowCall={onShowCall} />
            {pendingTotal > pending.length ? (
              <p className="tc-muted">
                Showing the {formatCount(pending.length)} soonest of {formatCount(pendingTotal)} pending
                follow-ups.
              </p>
            ) : null}
          </div>

          {data.total > 0 ? (
            <div className="tc-lead-followups tc-lead-followups--closed">
              <LoadingOverlay busy={loading}>
                <div>
                  <FollowUpGroup
                    title="Completed"
                    items={completed}
                    visibleCallIds={visibleCallIds}
                    onShowCall={onShowCall}
                  />
                  <FollowUpGroup
                    title="Cancelled"
                    items={cancelled}
                    visibleCallIds={visibleCallIds}
                    onShowCall={onShowCall}
                  />
                </div>
              </LoadingOverlay>
              <Pager
                page={data.page}
                totalPages={data.totalPages}
                total={data.total}
                noun="closed follow-up"
                busy={loading}
                onChange={goTo}
              />
            </div>
          ) : null}
        </>
      )}
    </LeadCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Notes                                                                       */
/* -------------------------------------------------------------------------- */

function NoteItem({
  note,
  callVisible,
  onShowCall,
}: {
  note: LeadNote;
  callVisible: boolean;
  onShowCall: (callId: number) => void;
}) {
  const system = note.kind === 'system';

  return (
    <li className={`tc-lead-note${system ? ' tc-lead-note--system' : ''}`}>
      <div className="tc-lead-note__meta">
        <Tag>{NOTE_KIND_LABELS[note.kind] ?? humanise(note.kind)}</Tag>
        {note.userName ? <span>{note.userName}</span> : null}
        <time dateTime={note.createdAt}>{formatDateTime(note.createdAt)}</time>
      </div>
      <p className="tc-prewrap tc-lead-note__body">{note.body}</p>
      {note.callId !== null && !system ? (
        <p className="tc-lead-note__call">
          <span className="tc-muted">Written on a call</span>
          {callVisible ? <ViewCallButton callId={note.callId} onShowCall={onShowCall} /> : null}
        </p>
      ) : null}
    </li>
  );
}

function NotesCard({
  leadId,
  initial,
  visibleCallIds,
  onShowCall,
  onError,
}: {
  leadId: number;
  initial: Paginated<LeadNote>;
  visibleCallIds: ReadonlySet<number>;
  onShowCall: (callId: number) => void;
  onError: HistoryErrorHandler;
}) {
  const fetchPage = useCallback(
    (page: number, signal: AbortSignal) =>
      telecallingApi.leadNotes(leadId, { page, pageSize: LEAD_VIEW_PAGE_SIZE }, signal),
    [leadId],
  );
  const { data, loading, error, goTo, retry, cardRef } = usePagedHistory(initial, fetchPage, onError);

  return (
    <LeadCard id={FOCUS_TARGETS.notes} title="Notes & remarks" count={data.total} sectionRef={cardRef}>
      {error ? <CardError message={error} onRetry={retry} /> : null}

      {data.total === 0 ? (
        <CardEmpty
          icon="file"
          title="No notes yet"
          body="Notes written after a call, or added to the lead, appear here newest first."
        />
      ) : (
        <>
          <LoadingOverlay busy={loading}>
            <ul className="tc-lead-notes">
              {data.items.map((note) => (
                <NoteItem
                  key={note.id}
                  note={note}
                  callVisible={note.callId !== null && visibleCallIds.has(note.callId)}
                  onShowCall={onShowCall}
                />
              ))}
            </ul>
          </LoadingOverlay>
          <Pager
            page={data.page}
            totalPages={data.totalPages}
            total={data.total}
            noun="note"
            busy={loading}
            onChange={goTo}
          />
        </>
      )}
    </LeadCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Activity                                                                    */
/* -------------------------------------------------------------------------- */

function ActivityCard({
  leadId,
  initial,
  onError,
}: {
  leadId: number;
  initial: Paginated<ActivityEntry>;
  onError: HistoryErrorHandler;
}) {
  const fetchPage = useCallback(
    (page: number, signal: AbortSignal) =>
      telecallingApi.leadActivity(leadId, { page, pageSize: LEAD_VIEW_PAGE_SIZE }, signal),
    [leadId],
  );
  const { data, loading, error, goTo, retry, cardRef } = usePagedHistory(initial, fetchPage, onError);
  const groups = useMemo(() => groupByIstDay(data.items, (entry) => entry.createdAt), [data]);

  return (
    <LeadCard id="tc-lead-activity" title="Activity" count={data.total} sectionRef={cardRef}>
      {error ? <CardError message={error} onRetry={retry} /> : null}

      {data.total === 0 ? (
        <CardEmpty
          icon="info"
          title="No activity yet"
          body="Every change to this lead — calls, notes, status, owner and follow-ups — is recorded here."
        />
      ) : (
        <>
          <LoadingOverlay busy={loading}>
            <div className="tc-timeline">
              {groups.map((group) => (
                <section key={group.day} className="tc-timeline__day">
                  <h4 className="tc-timeline__day-head">{formatDayHeading(group.day)}</h4>
                  <ol className="tc-activity">
                    {group.items.map((entry) => {
                      // Rendered from the summary the server wrote, whatever the type: a type
                      // this screen has never heard of still reads as what happened.
                      const meta = [ACTIVITY_LABELS[entry.type], entry.userName].filter(Boolean).join(' · ');
                      return (
                        <li key={entry.id} className="tc-activity__item">
                          <time className="tc-activity__time" dateTime={entry.createdAt}>
                            {formatTime(entry.createdAt)}
                          </time>
                          <div className="tc-activity__body">
                            <p className="tc-activity__summary">{entry.summary || humanise(entry.type)}</p>
                            {meta ? <p className="tc-activity__meta">{meta}</p> : null}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
            </div>
          </LoadingOverlay>
          <Pager
            page={data.page}
            totalPages={data.totalPages}
            total={data.total}
            noun="entry"
            nounPlural="entries"
            busy={loading}
            onChange={goTo}
          />
        </>
      )}
    </LeadCard>
  );
}

/* -------------------------------------------------------------------------- */
/* The view                                                                    */
/* -------------------------------------------------------------------------- */

/** Stands in for the whole view on the first load: the same shape, so nothing jumps. */
function LeadViewSkeleton() {
  return (
    <div className="tc-lead-view__body" aria-busy="true">
      <TableSkeleton rows={3} />
      <StatGridSkeleton count={5} />
      <div className="tc-lead-view__grid">
        <TableSkeleton rows={5} />
        <div className="tc-lead-view__aside">
          <TableSkeleton rows={3} />
          <TableSkeleton rows={3} />
        </div>
      </div>
    </div>
  );
}

export function LeadView({ onUnauthorized }: LeadViewProps) {
  const { leadId, leadFocus, closeLead, sectionLabel } = useTelecallingNav();

  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [detail, setDetail] = useState<LeadDetailResponse | null>(null);
  /** Bumped on every load, to remount the cards on the fresh first pages. */
  const [generation, setGeneration] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [visibleCallIds, setVisibleCallIds] = useState<ReadonlySet<number>>(() => new Set());
  const [highlightedCallId, setHighlightedCallId] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const handledFocusRef = useRef<LeadFocus | null>(null);
  const highlightTimerRef = useRef<number | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (leadId === null) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      if (mode === 'refresh') setRefreshing(true);
      else setState({ kind: 'loading' });
      setRefreshError(null);

      try {
        const next = await telecallingApi.leadDetail(leadId, controller.signal);
        setDetail(next);
        setGeneration((value) => value + 1);
        setState({ kind: 'ready' });
      } catch (caught) {
        if (isAbort(caught)) return;
        if (caught instanceof ApiError && caught.status === 401) {
          onUnauthorized();
          return;
        }
        if (caught instanceof ApiError && caught.status === 404) {
          setState({ kind: 'notFound' });
          return;
        }

        const message = caught instanceof ApiError ? caught.message : 'Could not load this lead.';
        // A failed refresh keeps what was already on screen and says so above it; only a
        // first load with nothing to show falls back to the error state.
        if (mode === 'refresh') setRefreshError(message);
        else setState({ kind: 'error', message });
      } finally {
        if (abortRef.current === controller) setRefreshing(false);
      }
    },
    [leadId, onUnauthorized],
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    },
    [],
  );

  // The link that opened this view is now hidden, and focus left on it would drop to the
  // top of the document. The heading takes it instead.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  /*
   * Opened at a particular card — from the lead list's notes column, say: once the cards
   * exist, scroll to it and put focus on its heading. Once per request, so a refresh does
   * not drag the reader back to it.
   */
  useEffect(() => {
    if (state.kind !== 'ready') return;
    if (leadFocus === null) {
      handledFocusRef.current = null;
      return;
    }
    if (handledFocusRef.current === leadFocus) return;
    handledFocusRef.current = leadFocus;

    const card = document.getElementById(FOCUS_TARGETS[leadFocus]);
    if (!card) return;
    card.scrollIntoView({ block: 'start', behavior: scrollBehaviour() });
    document.getElementById(`${FOCUS_TARGETS[leadFocus]}-title`)?.focus({ preventScroll: true });
  }, [state.kind, leadFocus]);

  const handleHistoryError = useCallback<HistoryErrorHandler>(
    (caught) => {
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return null;
      }
      // The lead went away — deleted, archived out of reach — while it was being read.
      if (caught instanceof ApiError && caught.status === 404) {
        setState({ kind: 'notFound' });
        return null;
      }
      return caught instanceof ApiError ? caught.message : 'Could not load this page.';
    },
    [onUnauthorized],
  );

  const onVisibleCallsChange = useCallback((callIds: number[]) => {
    setVisibleCallIds(new Set(callIds));
  }, []);

  /**
   * "View call": scrolls the call history to the call, puts focus on it, and marks it for
   * a moment so the eye lands on the right one among its neighbours.
   *
   * Scrolled rather than linked by `#fragment`, which would add a history entry per click
   * and make Back step through them before leaving the lead.
   */
  const showCall = useCallback((callId: number) => {
    const item = document.getElementById(callElementId(callId));
    if (!item) return;
    item.scrollIntoView({ block: 'center', behavior: scrollBehaviour() });
    item.focus({ preventScroll: true });

    setHighlightedCallId(callId);
    if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => {
      highlightTimerRef.current = null;
      setHighlightedCallId(null);
    }, 2500);
  }, []);

  if (leadId === null) return null;

  const lead = state.kind === 'ready' ? (detail?.lead ?? null) : null;

  return (
    <section className="tc-lead-view" aria-labelledby="tc-lead-view-title">
      <div className="tc-lead-view__head">
        <button type="button" className="btn btn--ghost btn--sm tc-lead-view__back" onClick={closeLead}>
          <Icon name="arrowLeft" size={16} />
          Back to {sectionLabel}
        </button>

        <div className="tc-lead-view__identity">
          <h2 id="tc-lead-view-title" ref={headingRef} tabIndex={-1} className="tc-lead-view__name">
            {lead ? (
              lead.customerName
            ) : state.kind === 'loading' ? (
              <>
                <span className="sr-only">Lead details</span>
                <span className="skeleton tc-skeleton--title tc-lead-view__name-skeleton" aria-hidden="true" />
              </>
            ) : (
              'Lead details'
            )}
          </h2>

          {lead ? (
            <div className="tc-lead-view__tags">
              <span className="tc-mono">{lead.reference}</span>
              <LeadStatusBadge status={lead.status} />
              {lead.isArchived ? <Tag>Archived</Tag> : null}
              {isPast(lead.nextFollowUpAt) ? <Tag tone="bad">Follow-up overdue</Tag> : null}
            </div>
          ) : null}
        </div>

        {lead ? (
          <div className="tc-lead-view__actions">
            <button
              type="button"
              className="btn btn--outline btn--sm"
              onClick={() => void load('refresh')}
              disabled={refreshing}
              aria-busy={refreshing || undefined}
            >
              {refreshing ? <ButtonSpinner /> : <Icon name="refresh" size={15} />}
              Refresh
            </button>
          </div>
        ) : null}
      </div>

      {state.kind === 'loading' ? <LeadViewSkeleton /> : null}

      {state.kind === 'error' ? (
        <div className="tc-lead-view__body">
          <FormAlert variant="error">{state.message}</FormAlert>
          <div>
            <button type="button" className="btn btn--outline btn--sm" onClick={() => void load('initial')}>
              <Icon name="refresh" size={15} />
              Try again
            </button>
          </div>
        </div>
      ) : null}

      {state.kind === 'notFound' ? (
        <EmptyPanel
          title="Lead not found"
          message="It may have been deleted, or the link is out of date."
          actionLabel={`Back to ${sectionLabel}`}
          onAction={closeLead}
        />
      ) : null}

      {state.kind === 'ready' && detail && lead ? (
        <LoadingOverlay busy={refreshing}>
          <div className="tc-lead-view__body">
            {refreshError ? <FormAlert variant="error">{refreshError}</FormAlert> : null}

            <LeadSummary lead={lead} lastCallAt={detail.callSummary.lastCallAt} />
            <CallFigures summary={detail.callSummary} />

            <div className="tc-lead-view__grid">
              <CallsCard
                key={`calls-${generation}`}
                leadId={leadId}
                lead={lead}
                initial={detail.calls}
                canPlayRecordings={detail.viewer.canPlayRecordings}
                highlightedCallId={highlightedCallId}
                onError={handleHistoryError}
                onVisibleCallsChange={onVisibleCallsChange}
              />

              <div className="tc-lead-view__aside">
                <FollowUpsCard
                  key={`follow-ups-${generation}`}
                  leadId={leadId}
                  pending={detail.followUps.pending}
                  initialClosed={detail.followUps.closed}
                  pendingCount={detail.counts.pendingFollowUps}
                  visibleCallIds={visibleCallIds}
                  onShowCall={showCall}
                  onError={handleHistoryError}
                />
                <NotesCard
                  key={`notes-${generation}`}
                  leadId={leadId}
                  initial={detail.notes}
                  visibleCallIds={visibleCallIds}
                  onShowCall={showCall}
                  onError={handleHistoryError}
                />
              </div>
            </div>

            <ActivityCard
              key={`activity-${generation}`}
              leadId={leadId}
              initial={detail.timeline}
              onError={handleHistoryError}
            />
          </div>
        </LoadingOverlay>
      ) : null}
    </section>
  );
}
