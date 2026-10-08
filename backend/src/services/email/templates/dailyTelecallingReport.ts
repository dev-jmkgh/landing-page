import { formatDuration } from '../../../utils/text';
import { renderEmail, renderText, type EmailDocument } from '../layout/base';
import {
  actionButton,
  callout,
  dataTable,
  formatSubmissionTime,
  metricGrid,
  paragraph,
  sectionHeading,
  textTable,
  type DataCell,
  type DataColumn,
  type MetricTile,
} from '../layout/components';

/**
 * The daily telecalling report, sent to the administrators each morning about the
 * previous IST day.
 *
 * Written for someone reading on a phone before the shift starts: what needs attention
 * first, then the day in three blocks of figures, then who did what. It names employees
 * — it is a staff report — but never a customer: no lead names, no phone numbers, nothing
 * that would make a forwarded copy a leak. The subject carries only the date, because
 * subject lines are what lock screens and shared inboxes show.
 *
 * The data shape is declared here rather than imported, like every other template's, so
 * the email layer never depends on a feature module. The report service's `DailyReport`
 * satisfies it as it is.
 */

export type DailyReportEmailData = {
  reportDate: string;
  partial: boolean;
  generatedAt: string;
  calls: {
    total: number;
    answered: number;
    notAnswered: number;
    outgoing: number;
    incoming: number;
    incomingMissed: number;
    talkTimeSeconds: number;
    averageAnsweredSeconds: number;
    answerRate: number;
  };
  leads: {
    created: number;
    contacted: number;
    attempted: number;
    converted: number;
    bySource: { key: string; label: string; total: number; converted: number }[];
  };
  followUps: {
    scheduled: number;
    due: number;
    completed: number;
    completedOnTime: number;
    completedLate: number;
    pending: number;
    overdue: number;
  };
  backlog: {
    unassignedLeads: number;
    pendingCallbacks: number;
    pendingRegistrations: number;
  };
  employees: {
    name: string;
    employeeCode: string;
    isActive: boolean;
    calls: number;
    outgoing: number;
    incoming: number;
    answered: number;
    missed: number;
    talkTimeSeconds: number;
    leadsContacted: number;
    followUpsCompleted: number;
    followUpsPending: number;
    leadsConverted: number;
  }[];
  overdueAlertHours: number;
  overdueByEmployee: { name: string; overdue: number; oldestDueAt: string }[];
};

export type DailyReportEmailLinks = {
  /** The admin dashboard, absolute. */
  dashboardUrl: string;
};

/**
 * The team table lists the busiest fifty and summarises the rest in a line — a larger
 * team would push everything after the table below the fold of every mail client.
 */
export const TEAM_TABLE_LIMIT = 50;

/** The worst five; the dashboard has the full list. */
const OVERDUE_TABLE_LIMIT = 5;

/*
 * Day and month names written out rather than taken from Intl: the subject line is
 * compared by tests and read by people, and ICU versions disagree about commas in
 * `en-GB` weekday formats. The date is a calendar date, so no time zone is involved.
 */
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `'Wed, 14 Jan 2026'` (short) or `'Wednesday, 14 January 2026'` (long). */
export function formatReportDay(date: string, style: 'short' | 'long' = 'short'): string {
  const at = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return date;

  const weekday = WEEKDAYS[at.getUTCDay()] ?? '';
  const month = MONTHS[at.getUTCMonth()] ?? '';
  return style === 'long'
    ? `${weekday}, ${at.getUTCDate()} ${month} ${at.getUTCFullYear()}`
    : `${weekday.slice(0, 3)}, ${at.getUTCDate()} ${month.slice(0, 3)} ${at.getUTCFullYear()}`;
}

const overdueSince = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
});

/** A count grouped the Indian way: `1,23,456`. */
function count(value: number): string {
  return value.toLocaleString('en-IN');
}

/** `'1 call'`, `'12 calls'`. */
function plural(value: number, one: string, many = `${one}s`): string {
  return `${count(value)} ${value === 1 ? one : many}`;
}

/** A duration, or a dash for none — `0s` reads like a measurement of nothing. */
function duration(seconds: number): string {
  return seconds > 0 ? formatDuration(seconds) : '—';
}

/** The text/plain rendering of a tile grid. */
function tileLines(tiles: readonly MetricTile[]): string[] {
  return tiles.map((tile) => `${tile.label}: ${tile.value}${tile.hint ? ` (${tile.hint})` : ''}`);
}

export function dailyTelecallingReportEmail(
  report: DailyReportEmailData,
  links: DailyReportEmailLinks,
): EmailDocument {
  const { calls, leads, followUps, backlog } = report;

  const longDay = formatReportDay(report.reportDate, 'long');
  const shortDay = formatReportDay(report.reportDate, 'short');
  const coverage = report.partial ? `${longDay} · so far today` : `${longDay} · 00:00–23:59 IST`;
  const generated = `Generated ${formatSubmissionTime(new Date(report.generatedAt))}`;
  const unfinished = 'The day is not over yet, so these figures are incomplete.';

  /* ------------------------------------------------------ needs attention */
  const attention = [
    followUps.overdue > 0 ? `${plural(followUps.overdue, 'follow-up')} overdue now` : null,
    calls.incomingMissed > 0
      ? `${plural(calls.incomingMissed, 'incoming call')} nobody answered`
      : null,
    backlog.pendingCallbacks > 0
      ? `${plural(backlog.pendingCallbacks, 'unanswered call')} still waiting for a call back`
      : null,
    backlog.unassignedLeads > 0
      ? `${plural(backlog.unassignedLeads, 'lead')} with nobody assigned`
      : null,
    backlog.pendingRegistrations > 0
      ? `${plural(backlog.pendingRegistrations, 'registration')} waiting for approval`
      : null,
  ].filter((line): line is string => line !== null);

  const attentionBlock =
    attention.length > 0
      ? callout(
          'Needs attention',
          attention.map((line) => `• ${line}`),
          'bad',
        )
      : callout(
          'Nothing needs attention',
          'No overdue follow-ups, unanswered incoming calls, waiting call-backs, unassigned leads or pending registrations.',
          'good',
        );

  /* -------------------------------------------------------------- figures */
  const callTiles: MetricTile[] = [
    { label: 'Calls', value: count(calls.total) },
    {
      label: 'Answered',
      value: count(calls.answered),
      hint: calls.total > 0 ? `${calls.answerRate}% of calls` : null,
      tone: calls.answered > 0 ? 'good' : 'default',
    },
    {
      label: 'Not answered',
      value: count(calls.notAnswered),
      tone: calls.notAnswered > 0 ? 'warn' : 'default',
    },
    { label: 'Talk time', value: duration(calls.talkTimeSeconds) },
    { label: 'Outgoing', value: count(calls.outgoing) },
    { label: 'Incoming', value: count(calls.incoming) },
    {
      label: 'Missed incoming',
      value: count(calls.incomingMissed),
      tone: calls.incomingMissed > 0 ? 'bad' : 'default',
    },
    { label: 'Average answered call', value: duration(calls.averageAnsweredSeconds) },
  ];

  const leadTiles: MetricTile[] = [
    { label: 'New leads', value: count(leads.created) },
    { label: 'Leads reached', value: count(leads.contacted), hint: 'with an answered call' },
    { label: 'Leads called', value: count(leads.attempted), hint: 'answered or not' },
    {
      label: 'Converted',
      value: count(leads.converted),
      tone: leads.converted > 0 ? 'good' : 'default',
    },
  ];

  const followUpTiles: MetricTile[] = [
    { label: 'Booked', value: count(followUps.scheduled) },
    { label: 'Due', value: count(followUps.due) },
    {
      label: 'Completed',
      value: count(followUps.completed),
      hint:
        followUps.completed > 0
          ? `${count(followUps.completedOnTime)} on time · ${count(followUps.completedLate)} late`
          : null,
    },
    { label: 'Pending now', value: count(followUps.pending) },
    {
      label: 'Overdue now',
      value: count(followUps.overdue),
      tone: followUps.overdue > 0 ? 'bad' : 'default',
    },
  ];

  /* ----------------------------------------------------------------- team */
  const shownEmployees = report.employees.slice(0, TEAM_TABLE_LIMIT);
  const hiddenEmployees = report.employees.length - shownEmployees.length;
  const teamNote =
    hiddenEmployees > 0
      ? `And ${plural(hiddenEmployees, 'more employee')} with fewer calls — the dashboard lists everyone.`
      : null;

  const teamColumns: DataColumn[] = [
    { label: 'Employee' },
    { label: 'Calls', align: 'right' },
    { label: 'Answered', align: 'right' },
    { label: 'Not answered', align: 'right' },
    { label: 'Talk time', align: 'right' },
    { label: 'Leads reached', align: 'right' },
    { label: 'Follow-ups done / pending', align: 'right' },
    { label: 'Converted', align: 'right' },
  ];
  const teamRows: DataCell[][] = shownEmployees.map((employee) => [
    {
      text: employee.name,
      sub: employee.isActive ? employee.employeeCode : `${employee.employeeCode} · deactivated`,
    },
    { text: employee.calls, sub: `${count(employee.outgoing)} out · ${count(employee.incoming)} in` },
    employee.answered,
    employee.missed,
    duration(employee.talkTimeSeconds),
    employee.leadsContacted,
    `${count(employee.followUpsCompleted)} / ${count(employee.followUpsPending)}`,
    employee.leadsConverted,
  ]);

  /* The plain-text table splits the two-line cells into columns of their own. */
  const teamTextColumns: DataColumn[] = [
    { label: 'Employee' },
    { label: 'Calls', align: 'right' },
    { label: 'Out', align: 'right' },
    { label: 'In', align: 'right' },
    { label: 'Answered', align: 'right' },
    { label: 'Not ans.', align: 'right' },
    { label: 'Talk', align: 'right' },
    { label: 'Reached', align: 'right' },
    { label: 'FU done/pending', align: 'right' },
    { label: 'Converted', align: 'right' },
  ];
  const teamTextRows: DataCell[][] = shownEmployees.map((employee) => [
    {
      text: employee.name,
      sub: employee.isActive ? employee.employeeCode : `${employee.employeeCode}, deactivated`,
    },
    employee.calls,
    employee.outgoing,
    employee.incoming,
    employee.answered,
    employee.missed,
    duration(employee.talkTimeSeconds),
    employee.leadsContacted,
    `${count(employee.followUpsCompleted)}/${count(employee.followUpsPending)}`,
    employee.leadsConverted,
  ]);

  /* --------------------------------------------------------------- sources */
  const sourceColumns: DataColumn[] = [
    { label: 'Source' },
    { label: 'New leads', align: 'right' },
    { label: 'Converted', align: 'right' },
  ];
  const sourceRows: DataCell[][] = leads.bySource.map((row) => [row.label, row.total, row.converted]);

  /* --------------------------------------------------------------- overdue */
  const hours = Math.max(Math.trunc(report.overdueAlertHours), 0);
  const overdueHeading =
    hours > 0 ? `Overdue by more than ${plural(hours, 'hour')}` : 'Overdue follow-ups';
  const overdueColumns: DataColumn[] = [
    { label: 'Employee' },
    { label: 'Overdue', align: 'right' },
    { label: 'Oldest was due', align: 'right' },
  ];
  const shownOverdue = report.overdueByEmployee.slice(0, OVERDUE_TABLE_LIMIT);
  const overdueRows: DataCell[][] = shownOverdue.map((group) => [
    group.name,
    group.overdue,
    overdueSince.format(new Date(group.oldestDueAt)),
  ]);
  const hiddenOverdue = report.overdueByEmployee.length - shownOverdue.length;
  const overdueNote =
    hiddenOverdue > 0 ? `And ${plural(hiddenOverdue, 'more employee')} with overdue follow-ups.` : null;
  const noOverdue =
    hours > 0
      ? `Nobody has a follow-up overdue by more than ${plural(hours, 'hour')}.`
      : 'Nobody has an overdue follow-up.';

  const howToRead =
    'Calls are counted on the day they happened; follow-up bookings and completions when ' +
    'they reached the system; "now" figures as at the time this email was generated. ' +
    "Incoming calls count only when they came in on an employee's company SIM. All times " +
    'are India Standard Time.';

  /* ------------------------------------------------------------------ html */
  const content = [
    paragraph(coverage, { size: 16 }),
    paragraph(generated, { muted: true, size: 13 }),
    ...(report.partial ? [paragraph(unfinished, { muted: true, size: 13 })] : []),
    attentionBlock,
    sectionHeading('Calls'),
    metricGrid(callTiles, 4),
    sectionHeading('Leads'),
    metricGrid(leadTiles, 4),
    sectionHeading('Follow-ups'),
    metricGrid(followUpTiles, 3),
    sectionHeading('Team'),
    dataTable({
      columns: teamColumns,
      rows: teamRows,
      emptyText: 'No telecaller activity that day.',
      note: teamNote,
    }),
    sectionHeading('New leads by source'),
    dataTable({ columns: sourceColumns, rows: sourceRows, emptyText: 'No new leads that day.' }),
    sectionHeading(overdueHeading),
    overdueRows.length > 0
      ? dataTable({ columns: overdueColumns, rows: overdueRows, note: overdueNote })
      : paragraph(noOverdue, { muted: true, size: 13 }),
    sectionHeading('How to read this'),
    paragraph(howToRead, { muted: true, size: 12 }),
    actionButton('Open the telecalling dashboard', links.dashboardUrl),
  ].join('\n');

  /* ------------------------------------------------------------------ text */
  const text = renderText([
    'DAILY TELECALLING REPORT',
    coverage,
    generated,
    ...(report.partial ? [unfinished] : []),
    '',
    attention.length > 0 ? 'NEEDS ATTENTION' : 'NOTHING NEEDS ATTENTION',
    ...attention.map((line) => `- ${line}`),
    '',
    'CALLS',
    ...tileLines(callTiles),
    '',
    'LEADS',
    ...tileLines(leadTiles),
    '',
    'FOLLOW-UPS',
    ...tileLines(followUpTiles),
    '',
    'TEAM',
    ...(teamTextRows.length > 0
      ? textTable(teamTextColumns, teamTextRows)
      : ['No telecaller activity that day.']),
    ...(teamNote ? [teamNote] : []),
    '',
    'NEW LEADS BY SOURCE',
    ...(sourceRows.length > 0 ? textTable(sourceColumns, sourceRows) : ['No new leads that day.']),
    '',
    overdueHeading.toUpperCase(),
    ...(overdueRows.length > 0 ? textTable(overdueColumns, overdueRows) : [noOverdue]),
    ...(overdueNote ? [overdueNote] : []),
    '',
    'HOW TO READ THIS',
    howToRead,
    '',
    `Open the telecalling dashboard: ${links.dashboardUrl}`,
  ]);

  return {
    subject: `Telecalling daily report — ${shortDay}${report.partial ? ' (so far)' : ''}`,
    html: renderEmail({
      title: 'Daily telecalling report',
      preheader: [
        plural(calls.total, 'call'),
        `${count(calls.answered)} answered`,
        plural(leads.created, 'new lead'),
        `${plural(followUps.overdue, 'follow-up')} overdue`,
      ].join(' · '),
      content,
    }),
    text,
  };
}
