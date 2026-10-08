import { query, queryOne, type RowDataPacket } from '../../../db/pool';
import type { ActivityRecord, ActivityRow } from '../activity/activity.repository';
import {
  FOLLOW_UP_SELECT,
  toFollowUpRecord,
  type FollowUpRecord,
  type FollowUpRow,
} from '../followups/followUp.repository';
import { resolvePage, type Paginated } from '../shared.schema';

/**
 * Reads behind the admin Lead View that span other modules' tables: one lead's
 * follow-ups and activity, a page at a time, and the counts over its whole history. The
 * call history and its figures are the calls module's (`listLeadCallsPage`,
 * `leadCallSummary`), and the status set on each call is the activity module's
 * (`listCallStatusChanges`).
 *
 * Every history here is read one bounded page at a time with its total — never "the
 * latest N" with the rest silently dropped. The only list without pages is the lead's
 * PENDING follow-ups, which is open work rather than history and is capped, with its true
 * count beside it, rather than paged.
 *
 * Each function takes a lead id the caller has ALREADY checked the actor may see; none of
 * them applies ownership. The service is the only caller, and checks first.
 */

/* -------------------------------------------------------------------------- */
/* Follow-ups                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The lead's open follow-ups, soonest first, at most `cap` of them.
 *
 * Not paged: this is the work still to do, which on a real lead is a handful, and the
 * screen shows it whole. The cap is a guard, not a page — `countLeadHistory` reports the
 * true pending count beside it, so a lead that ever exceeds it says so rather than
 * dropping rows silently. Walks `idx_follow_ups_lead (lead_id, due_at)`.
 */
export async function listLeadPendingFollowUps(
  leadId: number,
  cap: number,
): Promise<FollowUpRecord[]> {
  const bounded = Math.min(Math.max(Math.trunc(cap), 1), 100);
  const rows = await query<FollowUpRow>(
    `${FOLLOW_UP_SELECT}
      WHERE f.lead_id = ? AND f.state = 'pending'
      ORDER BY f.due_at ASC, f.id ASC
      LIMIT ${bounded}`,
    [leadId],
  );
  return rows.map(toFollowUpRecord);
}

/**
 * One page of the lead's closed follow-ups — completed and cancelled — newest first.
 *
 * "Newest" is when it was closed: `completed_at` for a completed one, and for a cancelled
 * one `updated_at`, which the cancellation is the last write to (nothing changes a closed
 * follow-up afterwards). The id breaks ties within a second, so pages never overlap.
 */
export async function listLeadClosedFollowUpsPage(
  leadId: number,
  page: number,
  pageSize: number,
): Promise<Paginated<FollowUpRecord>> {
  const countRow = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total
       FROM follow_ups
      WHERE lead_id = ? AND state IN ('completed', 'cancelled')`,
    [leadId],
  );
  const total = Number(countRow?.total ?? 0);
  const resolved = resolvePage({ page, pageSize }, total);

  const rows = await query<FollowUpRow>(
    `${FOLLOW_UP_SELECT}
      WHERE f.lead_id = ? AND f.state IN ('completed', 'cancelled')
      ORDER BY COALESCE(f.completed_at, f.updated_at) DESC, f.id DESC
      LIMIT ${resolved.pageSize} OFFSET ${resolved.offset}`,
    [leadId],
  );

  return {
    items: rows.map(toFollowUpRecord),
    page: resolved.page,
    pageSize: resolved.pageSize,
    total,
    totalPages: resolved.totalPages,
  };
}

/* -------------------------------------------------------------------------- */
/* Activity                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * MySQL returns a JSON column already parsed; MariaDB returns the text, its JSON being an
 * alias for LONGTEXT. The activity module's reader does the same; this is its copy, kept
 * here so a paged timeline needs no change to a module this feature does not own.
 */
function parseMeta(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * One page of the lead's timeline, newest first, over `idx_lead_activities_lead`.
 *
 * Every type is returned as stored, including ones this API does not list — older rows
 * and seeded data carry types like `created` — because the screen renders an entry from
 * its summary and must never lose a row it cannot name.
 */
export async function listLeadActivityPage(
  leadId: number,
  page: number,
  pageSize: number,
): Promise<Paginated<ActivityRecord>> {
  const countRow = await queryOne<RowDataPacket & { total: number }>(
    'SELECT COUNT(*) AS total FROM lead_activities WHERE lead_id = ?',
    [leadId],
  );
  const total = Number(countRow?.total ?? 0);
  const resolved = resolvePage({ page, pageSize }, total);

  const rows = await query<ActivityRow>(
    `SELECT a.id, a.lead_id, a.user_id, u.name AS user_name, a.type, a.summary, a.meta, a.created_at
       FROM lead_activities a
       LEFT JOIN telecaller_users u ON u.id = a.user_id
      WHERE a.lead_id = ?
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${resolved.pageSize} OFFSET ${resolved.offset}`,
    [leadId],
  );

  return {
    items: rows.map((row) => ({
      id: row.id,
      leadId: row.lead_id,
      userId: row.user_id,
      userName: row.user_name,
      type: row.type,
      summary: row.summary,
      meta: parseMeta(row.meta),
      createdAt: new Date(row.created_at).toISOString(),
    })),
    page: resolved.page,
    pageSize: resolved.pageSize,
    total,
    totalPages: resolved.totalPages,
  };
}

/* -------------------------------------------------------------------------- */
/* Counts                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Whole-history counts for the Lead View's card headings.
 *
 * `notes` counts what people wrote — system notes, which the notes page includes and the
 * screen mutes, are left out. `pendingFollowUps` is the true open count, which is what
 * tells the screen whether its capped pending list is complete.
 */
export type LeadHistoryCounts = {
  notes: number;
  followUps: number;
  pendingFollowUps: number;
  activities: number;
};

export async function countLeadHistory(leadId: number): Promise<LeadHistoryCounts> {
  const row = await queryOne<
    RowDataPacket & {
      notes: number | string | null;
      follow_ups: number | string | null;
      pending_follow_ups: number | string | null;
      activities: number | string | null;
    }
  >(
    `SELECT (SELECT COUNT(*) FROM lead_notes WHERE lead_id = ? AND kind <> 'system') AS notes,
            (SELECT COUNT(*) FROM follow_ups WHERE lead_id = ?) AS follow_ups,
            (SELECT COUNT(*) FROM follow_ups WHERE lead_id = ? AND state = 'pending') AS pending_follow_ups,
            (SELECT COUNT(*) FROM lead_activities WHERE lead_id = ?) AS activities`,
    [leadId, leadId, leadId, leadId],
  );

  return {
    notes: Number(row?.notes ?? 0),
    followUps: Number(row?.follow_ups ?? 0),
    pendingFollowUps: Number(row?.pending_follow_ups ?? 0),
    activities: Number(row?.activities ?? 0),
  };
}
