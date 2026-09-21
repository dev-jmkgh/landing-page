#!/usr/bin/env node
/**
 * Lists active leads that share a phone number.
 *
 *   npm run leads:duplicates
 *
 * One active lead per number is enforced when a lead is created or its number is edited,
 * so nothing new can land here. What this finds is history: pairs that predate the rule,
 * and the occasional pair from two requests arriving in the same instant, which the
 * service check cannot see and no unique index is there to catch.
 *
 * Worth running now and then, because a duplicate is not a cosmetic problem. Calls from
 * that number stop attaching to either lead — the server will not guess between two
 * matches — so the customer's history splits in half and the Incoming list shows them as
 * a caller it cannot place.
 *
 * It only reports. Merging two customer records is not something a script should decide:
 * each may carry calls, notes and follow-ups, and picking a survivor automatically would
 * discard one person's history with no way back. Choose which record stays, archive the
 * other from the admin portal, and run this again.
 *
 * Plain Node against `.env`, with no build step, so it can be run on a server whose
 * `dist` is mid-deploy or missing.
 */
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const connection = await mysql.createConnection({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME,
});

/*
 * `phone_key` (migration 015) is the trailing nine digits of whatever was typed, so
 * `+91 98765 43210` and `09876543210` are one value — and the same one the duplicate
 * check compares against, so this report cannot disagree with the rule it is auditing.
 *
 * Read from the stored column rather than recomputed here. The first version spelled the
 * expression out and aliased it `phone_key`, which worked until the real column existed
 * and then started binding `GROUP BY phone_key` to the column instead of the alias —
 * leaving the SELECT expression outside the grouping and failing under
 * `only_full_group_by`. Using the column is both correct and indexed.
 *
 * NULL means archived, which releases the number, so those are excluded.
 */
const [groups] = await connection.query(
  `SELECT phone_key, COUNT(*) AS total
     FROM leads
    WHERE is_archived = 0
      AND phone_key IS NOT NULL
    GROUP BY phone_key
   HAVING total > 1
    ORDER BY total DESC, phone_key`,
);

if (groups.length === 0) {
  console.log('\nNo active leads share a phone number.\n');
  await connection.end();
  process.exit(0);
}

console.log(`\n${groups.length} number(s) are held by more than one active lead:\n`);

for (const group of groups) {
  const [leads] = await connection.query(
    `SELECT l.id, l.reference, l.customer_name, l.phone, l.status, l.created_at,
            u.name AS owner,
            (SELECT COUNT(*) FROM calls c WHERE c.lead_id = l.id)       AS calls,
            (SELECT COUNT(*) FROM lead_notes n WHERE n.lead_id = l.id)  AS notes
       FROM leads l
       LEFT JOIN telecaller_users u ON u.id = l.assigned_to
      WHERE l.is_archived = 0
        AND l.phone_key = ?
      ORDER BY l.created_at`,
    [group.phone_key],
  );

  console.log(`  …${group.phone_key}`);

  for (const lead of leads) {
    const owner = lead.owner ?? 'unassigned';
    const created = new Date(lead.created_at).toISOString().slice(0, 10);
    // Calls and notes are shown because they are what makes one record the one worth
    // keeping: archiving the side that holds the history is the expensive mistake.
    console.log(
      `    ${lead.reference}  ${lead.customer_name.padEnd(24)} ${String(lead.phone).padEnd(18)}` +
        ` ${lead.status.padEnd(18)} ${owner.padEnd(16)} created ${created}` +
        `  ${lead.calls} call(s), ${lead.notes} note(s)`,
    );
  }

  console.log('');
}

console.log(
  'These predate the one-lead-per-number rule, or slipped through it, and are left alone\n' +
    'on purpose — resolving them means choosing whose history survives. Archive all but\n' +
    'one lead in each group from the admin portal, then re-run.\n',
);

await connection.end();
process.exit(1);
