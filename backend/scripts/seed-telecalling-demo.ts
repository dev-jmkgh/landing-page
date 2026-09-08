/**
 * Fills the telecalling tables with realistic demo data.
 *
 *   npm run db:seed:telecalling
 *
 * This exists so every screen in both apps can be exercised without hand-entering data.
 * An empty database makes most of the UI look broken rather than empty: the dashboard
 * tiles read zero, the lists show their empty states, and nothing proves whether a
 * filter, a badge or an overdue calculation actually works.
 *
 * What it deliberately covers, because these are the cases an ad-hoc "add three leads"
 * session never reaches:
 *
 *   - every one of the ten lead statuses, so `statusColor` is exercised end to end
 *   - every one of the six call outcomes, INCLUDING `missed` — the dashboard's Missed
 *     tile reads zero on real data because no client path produces that outcome, so
 *     without seeding it there is no way to tell the tile works from the tile being wrong
 *   - follow-ups that are overdue, due today, due this week, completed and cancelled,
 *     since "overdue" is derived at read time and is the easiest thing to get wrong
 *   - a pending and a rejected registration, so the admin approval queue is not empty
 *   - read and unread notifications
 *   - leads with and without an assignee, so ownership scoping is visible
 *
 * Re-runnable: it clears the telecalling tables first. It does NOT touch `enquiries`,
 * `job_applications` or `admin_users` — the website's own data lives there and wiping it
 * while demoing the telecalling module would be an unpleasant surprise.
 */
import bcrypt from 'bcryptjs';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

/* -------------------------------------------------------------------------- */
/* Guards                                                                      */
/* -------------------------------------------------------------------------- */

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run: NODE_ENV is production.');
  console.error('This script deletes every row in the telecalling tables.');
  process.exit(1);
}

/**
 * Refuse to wipe whichever database `.env.production` names.
 *
 * The NODE_ENV check above is not enough on its own. It is set by the systemd unit for
 * the service, not by a shell — so an operator who sshes in and runs this by hand, or
 * who reaches for it while looking for a way to create an admin employee row, has no
 * NODE_ENV at all and sails straight past it. The command then empties `leads`, `calls`
 * and `follow_ups` on the live system.
 *
 * The production database name is read from `.env.production` rather than hard-coded, so
 * this keeps protecting the right database if it is ever renamed.
 *
 * To grant an admin access to the telecalling screens — the reason someone is most
 * likely to be looking at this file — use `npm run admin:link` instead. It inserts one
 * row and deletes nothing.
 */
const targetDb = process.env.DB_NAME ?? 'jmk';

try {
  const productionEnv = readFileSync('.env.production', 'utf8');
  const productionDb = /^DB_NAME=(.*)$/m.exec(productionEnv)?.[1]?.trim();

  if (productionDb && productionDb === targetDb && process.env.CONFIRM_WIPE !== targetDb) {
    console.error(`Refusing to run: "${targetDb}" is the database named in .env.production.`);
    console.error('');
    console.error('This script DELETES every row in the telecalling tables — leads, calls,');
    console.error('follow-ups, notes and employees.');
    console.error('');
    console.error('If you only need to give an admin access to the telecalling screens:');
    console.error('    npm run admin:link -- their@email.com');
    console.error('');
    console.error(`If you genuinely mean to wipe it:  CONFIRM_WIPE=${targetDb} npm run db:seed:telecalling`);
    process.exit(1);
  }
} catch {
  // No .env.production on this machine, so there is no production name to protect
  // against. The NODE_ENV check above still applies.
}

/**
 * The demo password.
 *
 * Not hard-coded. `SEED_DEMO_PASSWORD` is used when set; otherwise one is generated and
 * printed once. A committed password in a repo that also holds a devtunnel URL is a
 * genuinely bad combination — the tunnel is reachable by anyone who has the link.
 */
const password = process.env.SEED_DEMO_PASSWORD ?? crypto.randomBytes(9).toString('base64url');

if (password.length < 12) {
  console.error('SEED_DEMO_PASSWORD must be at least 12 characters (the API enforces it).');
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */

const now = new Date();

/**
 * A Date as the DATETIME string this application stores.
 *
 * UTC components, not local ones. `src/db/pool.ts` creates the pool with
 * `timezone: 'Z'`, so mysql2 writes a bound Date as its UTC wall clock and parses a
 * DATETIME back as UTC. Every timestamp the API returns is therefore
 * `new Date(<utc wall clock>).toISOString()`.
 *
 * Writing local components here instead put every seeded row 5h30m ahead of where it
 * belonged once the app rendered it: a follow-up seeded for 18:30 IST was stored as
 * "18:30:00", read back as 18:30Z and displayed as 00:00 IST the next day. The seed has
 * to use the application's convention, not the database server's local clock.
 */
function sql(date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())} ` +
    `${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}`
  );
}

function shift(opts: { days?: number; hours?: number; minutes?: number }): Date {
  const d = new Date(now);
  if (opts.days) d.setDate(d.getDate() + opts.days);
  if (opts.hours) d.setHours(d.getHours() + opts.hours);
  if (opts.minutes) d.setMinutes(d.getMinutes() + opts.minutes);
  return d;
}

/** Today at a given hour — used so "due today" really is today, not 24h from now. */
function todayAt(hour: number, minute = 0): Date {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  return d;
}

const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function reference(prefix: string): string {
  let code = '';
  for (const byte of crypto.randomBytes(8)) {
    code += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  }
  return `${prefix}-${code}`;
}

function uuid(): string {
  return crypto.randomUUID();
}

/* -------------------------------------------------------------------------- */
/* The people                                                                  */
/* -------------------------------------------------------------------------- */

type SeedUser = {
  key: string;
  code: string;
  name: string;
  email: string;
  phone: string;
  role: 'admin' | 'manager' | 'supervisor' | 'telecaller';
  availability: 'available' | 'busy' | 'on_break' | 'offline';
  active: boolean;
  approval: 'pending' | 'approved' | 'rejected';
  rejectionReason?: string;
};

const USERS: SeedUser[] = [
  {
    key: 'admin',
    code: 'TC-1001',
    name: 'Asha Menon',
    email: 'asha.admin@jmkdemo.test',
    phone: '9845010001',
    role: 'admin',
    availability: 'available',
    active: true,
    approval: 'approved',
  },
  {
    key: 'manager',
    code: 'TC-1002',
    name: 'Rahul Verma',
    email: 'rahul.manager@jmkdemo.test',
    phone: '9845010002',
    role: 'manager',
    availability: 'available',
    active: true,
    approval: 'approved',
  },
  {
    key: 'supervisor',
    code: 'TC-1003',
    name: 'Fatima Sheikh',
    email: 'fatima.supervisor@jmkdemo.test',
    phone: '9845010003',
    role: 'supervisor',
    availability: 'busy',
    active: true,
    approval: 'approved',
  },
  {
    key: 'ravi',
    code: 'TC-1004',
    name: 'Ravi Kumar',
    email: 'ravi@jmkdemo.test',
    phone: '9845010004',
    role: 'telecaller',
    availability: 'available',
    active: true,
    approval: 'approved',
  },
  {
    key: 'mira',
    code: 'TC-1005',
    name: 'Mira Nair',
    email: 'mira@jmkdemo.test',
    phone: '9845010005',
    role: 'telecaller',
    availability: 'on_break',
    active: true,
    approval: 'approved',
  },
  {
    key: 'sanjay',
    code: 'TC-1006',
    name: 'Sanjay Patel',
    email: 'sanjay@jmkdemo.test',
    phone: '9845010006',
    role: 'telecaller',
    availability: 'offline',
    active: true,
    approval: 'approved',
  },
  {
    key: 'deepa',
    code: 'TC-1007',
    name: 'Deepa Iyer',
    email: 'deepa@jmkdemo.test',
    phone: '9845010007',
    role: 'telecaller',
    availability: 'offline',
    active: true,
    approval: 'approved',
  },
  /* Deactivated but approved — proves a suspended account is distinct from a pending one. */
  {
    key: 'former',
    code: 'TC-1008',
    name: 'Vikram Rao',
    email: 'vikram.former@jmkdemo.test',
    phone: '9845010008',
    role: 'telecaller',
    availability: 'offline',
    active: false,
    approval: 'approved',
  },
  /* The approval queue. Without these the admin's pending list is empty and untestable. */
  {
    key: 'pending1',
    code: 'TC-1009',
    name: 'Priya Sharma',
    email: 'priya.new@jmkdemo.test',
    phone: '9845010009',
    role: 'telecaller',
    availability: 'offline',
    active: false,
    approval: 'pending',
  },
  {
    key: 'pending2',
    code: 'TC-1010',
    name: 'Arjun Das',
    email: 'arjun.new@jmkdemo.test',
    phone: '9845010010',
    role: 'telecaller',
    availability: 'offline',
    active: false,
    approval: 'pending',
  },
  {
    key: 'rejected',
    code: 'TC-1011',
    name: 'Unknown Applicant',
    email: 'stranger@jmkdemo.test',
    phone: '9845010011',
    role: 'telecaller',
    availability: 'offline',
    active: false,
    approval: 'rejected',
    rejectionReason: 'Not a member of staff.',
  },
];

/**
 * The website administrator, as a telecalling employee.
 *
 * This is not decoration — without it the telecalling admin screens are unreachable.
 * `src/middleware/actor.ts` turns an admin cookie into a telecalling actor by looking up
 * the session's **email** in `telecaller_users` and requiring an active, approved row.
 * The website admin password lives in `ADMIN_PASSWORD_HASH` and `admin_users` may well
 * be empty, so nothing else creates that row.
 *
 * Since this script deletes every `telecaller_users` row first, omitting it meant the
 * operator signed in to the admin portal successfully and then got "This account is not
 * set up for the telecalling system" from every panel.
 *
 * The address is read from the environment rather than written here, so the seed follows
 * whoever the deployment's administrator actually is.
 */
const ADMIN_LOGIN_EMAIL = (process.env.ADMIN_LOGIN_EMAIL ?? process.env.ADMIN_EMAIL ?? '')
  .trim()
  .toLowerCase();

/* -------------------------------------------------------------------------- */
/* The leads                                                                   */
/* -------------------------------------------------------------------------- */

type SeedLead = {
  name: string;
  phone: string;
  email: string | null;
  city: string;
  address: string | null;
  source: string;
  product: string;
  status: string;
  owner: string | null;
  createdDaysAgo: number;
  summary: string | null;
};

/*
 * `as const` matters here. The scripts tsconfig sets `noUncheckedIndexedAccess`, so
 * indexing a plain string[] yields `string | undefined` and every PRODUCTS[n] below
 * would need a non-null assertion. As a readonly tuple the element types are known, so
 * the literal indices are checked properly instead of asserted away.
 */
const PRODUCTS = [
  'Medical equipment financing',
  'Hospital consumables',
  'Diagnostic lab setup',
  'Surgical instruments',
  'Patient monitoring systems',
  'Pharmacy distribution',
] as const;

/*
 * All ten statuses appear, and the count per status is uneven on purpose: an even
 * spread makes a broken "group by status" look correct.
 */
const LEADS: SeedLead[] = [
  { name: 'Suresh Babu', phone: '9000000101', email: 'suresh.babu@example.test', city: 'Kochi', address: '14/2 Marine Drive, Ernakulam', source: 'website', product: PRODUCTS[0], status: 'new', owner: 'ravi', createdDaysAgo: 0, summary: null },
  { name: 'Lakshmi Menon', phone: '9000000102', email: 'lakshmi.m@example.test', city: 'Bengaluru', address: '221 Indiranagar 100ft Road', source: 'website', product: PRODUCTS[1], status: 'new', owner: 'ravi', createdDaysAgo: 0, summary: null },
  { name: 'Anand Krishnan', phone: '9000000103', email: null, city: 'Chennai', address: null, source: 'advertisement', product: PRODUCTS[2], status: 'new', owner: 'mira', createdDaysAgo: 1, summary: null },
  { name: 'Rekha Pillai', phone: '9000000104', email: 'rekha.p@example.test', city: 'Kochi', address: '8 Panampilly Nagar', source: 'referral', product: PRODUCTS[3], status: 'new', owner: null, createdDaysAgo: 1, summary: null },
  { name: 'Mohammed Ashraf', phone: '9000000105', email: 'ashraf@example.test', city: 'Hyderabad', address: '3rd Floor, Banjara Hills', source: 'manual', product: PRODUCTS[4], status: 'new', owner: null, createdDaysAgo: 2, summary: null },

  { name: 'Geetha Raman', phone: '9000000106', email: 'geetha.r@example.test', city: 'Chennai', address: '45 T Nagar', source: 'website', product: PRODUCTS[0], status: 'contacted', owner: 'ravi', createdDaysAgo: 3, summary: 'Asked for a written quotation.' },
  { name: 'Vivek Sharma', phone: '9000000107', email: null, city: 'Delhi', address: null, source: 'advertisement', product: PRODUCTS[5], status: 'contacted', owner: 'mira', createdDaysAgo: 3, summary: 'Wants to compare against current supplier.' },
  { name: 'Nisha Thomas', phone: '9000000108', email: 'nisha.t@example.test', city: 'Kochi', address: '2B Kakkanad', source: 'referral', product: PRODUCTS[1], status: 'contacted', owner: 'sanjay', createdDaysAgo: 4, summary: null },
  { name: 'Prakash Nayak', phone: '9000000109', email: 'prakash.n@example.test', city: 'Mumbai', address: '19 Andheri East', source: 'hard_copy', product: PRODUCTS[2], status: 'contacted', owner: 'deepa', createdDaysAgo: 5, summary: 'Hard copy form collected at the trade fair.' },

  { name: 'Divya Raghavan', phone: '9000000110', email: 'divya.r@example.test', city: 'Bengaluru', address: '7 Koramangala 5th Block', source: 'website', product: PRODUCTS[2], status: 'interested', owner: 'ravi', createdDaysAgo: 6, summary: 'Budget approved for next quarter. Send the full catalogue.' },
  { name: 'Karthik Subramanian', phone: '9000000111', email: 'karthik.s@example.test', city: 'Chennai', address: '90 Adyar', source: 'referral', product: PRODUCTS[3], status: 'interested', owner: 'mira', createdDaysAgo: 7, summary: 'Very keen. Decision maker is the medical director.' },
  { name: 'Sunita Agarwal', phone: '9000000112', email: null, city: 'Pune', address: null, source: 'advertisement', product: PRODUCTS[4], status: 'interested', owner: 'sanjay', createdDaysAgo: 8, summary: 'Wants an on-site demonstration.' },

  { name: 'Ramesh Gupta', phone: '9000000113', email: 'ramesh.g@example.test', city: 'Delhi', address: '55 Karol Bagh', source: 'website', product: PRODUCTS[0], status: 'follow_up', owner: 'ravi', createdDaysAgo: 9, summary: 'Call back after their board meeting.' },
  { name: 'Aishwarya Rao', phone: '9000000114', email: 'aishwarya.r@example.test', city: 'Bengaluru', address: '12 Whitefield', source: 'manual', product: PRODUCTS[1], status: 'follow_up', owner: 'mira', createdDaysAgo: 10, summary: 'Asked us to try again next week.' },
  { name: 'Joseph Mathew', phone: '9000000115', email: null, city: 'Kochi', address: '31 Fort Kochi', source: 'referral', product: PRODUCTS[5], status: 'follow_up', owner: 'deepa', createdDaysAgo: 11, summary: null },

  { name: 'Meenakshi Sundaram', phone: '9000000116', email: 'meena.s@example.test', city: 'Chennai', address: '6 Mylapore', source: 'website', product: PRODUCTS[3], status: 'callback_requested', owner: 'ravi', createdDaysAgo: 4, summary: 'Asked for a call after 6pm.' },
  { name: 'Imran Qureshi', phone: '9000000117', email: null, city: 'Hyderabad', address: null, source: 'advertisement', product: PRODUCTS[4], status: 'callback_requested', owner: 'sanjay', createdDaysAgo: 5, summary: 'In a meeting; call tomorrow morning.' },

  { name: 'Padma Venkatesh', phone: '9000000118', email: 'padma.v@example.test', city: 'Bengaluru', address: '77 Jayanagar', source: 'referral', product: PRODUCTS[2], status: 'converted', owner: 'ravi', createdDaysAgo: 20, summary: 'Signed for two diagnostic units. Invoice raised.' },
  { name: 'Sanjeev Kapoor', phone: '9000000119', email: 'sanjeev.k@example.test', city: 'Mumbai', address: '4 Bandra West', source: 'website', product: PRODUCTS[0], status: 'converted', owner: 'mira', createdDaysAgo: 25, summary: 'Financing agreement completed.' },
  { name: 'Tara Bhattacharya', phone: '9000000120', email: 'tara.b@example.test', city: 'Delhi', address: '18 Saket', source: 'referral', product: PRODUCTS[1], status: 'converted', owner: 'deepa', createdDaysAgo: 30, summary: 'Monthly consumables contract.' },

  { name: 'Bhaskar Reddy', phone: '9000000121', email: null, city: 'Hyderabad', address: null, source: 'advertisement', product: PRODUCTS[5], status: 'not_interested', owner: 'ravi', createdDaysAgo: 12, summary: 'Already under a three-year contract elsewhere.' },
  { name: 'Shalini Desai', phone: '9000000122', email: 'shalini.d@example.test', city: 'Pune', address: '23 Kothrud', source: 'website', product: PRODUCTS[4], status: 'not_interested', owner: 'mira', createdDaysAgo: 14, summary: 'Not the right size of facility for this product.' },

  { name: 'Gopal Menon', phone: '9000000123', email: null, city: 'Kochi', address: null, source: 'manual', product: PRODUCTS[3], status: 'lost', owner: 'sanjay', createdDaysAgo: 18, summary: 'Went with a cheaper competitor.' },
  { name: 'Harish Chandra', phone: '9000000124', email: 'harish.c@example.test', city: 'Chennai', address: null, source: 'website', product: PRODUCTS[0], status: 'lost', owner: 'deepa', createdDaysAgo: 22, summary: 'Project shelved.' },

  { name: 'Wrong Number Entry', phone: '9000000125', email: null, city: 'Mumbai', address: null, source: 'hard_copy', product: PRODUCTS[1], status: 'invalid_number', owner: 'ravi', createdDaysAgo: 6, summary: 'Number belongs to an unrelated person.' },
  { name: 'Kavya Menon', phone: '9000000126', email: null, city: 'Bengaluru', address: null, source: 'advertisement', product: PRODUCTS[2], status: 'invalid_number', owner: 'mira', createdDaysAgo: 8, summary: 'Digit missing on the printed form.' },

  { name: 'Naveen Joshi', phone: '9000000127', email: null, city: 'Pune', address: null, source: 'website', product: PRODUCTS[5], status: 'not_reachable', owner: 'sanjay', createdDaysAgo: 7, summary: 'Four attempts, no answer.' },
  { name: 'Sneha Kulkarni', phone: '9000000128', email: 'sneha.k@example.test', city: 'Pune', address: null, source: 'referral', product: PRODUCTS[4], status: 'not_reachable', owner: 'deepa', createdDaysAgo: 9, summary: 'Phone switched off each time.' },

  /* Unassigned backlog, so the admin's assignment screen has something to do. */
  { name: 'Anita Desai', phone: '9000000129', email: 'anita.d@example.test', city: 'Mumbai', address: '9 Colaba', source: 'website', product: PRODUCTS[0], status: 'new', owner: null, createdDaysAgo: 0, summary: null },
  { name: 'Rajesh Khanna', phone: '9000000130', email: null, city: 'Delhi', address: null, source: 'advertisement', product: PRODUCTS[3], status: 'new', owner: null, createdDaysAgo: 0, summary: null },
  { name: 'Farida Contractor', phone: '9000000131', email: 'farida.c@example.test', city: 'Mumbai', address: '2 Worli', source: 'referral', product: PRODUCTS[1], status: 'new', owner: null, createdDaysAgo: 1, summary: null },
  { name: 'Ganesh Iyer', phone: '9000000132', email: null, city: 'Chennai', address: null, source: 'hard_copy', product: PRODUCTS[2], status: 'new', owner: null, createdDaysAgo: 2, summary: null },
];

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Lookups                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Ids of the rows this script inserted, resolved by name.
 *
 * These throw rather than returning undefined. Under `noUncheckedIndexedAccess` the
 * alternative is a non-null assertion at every call site, which would turn a mistyped
 * key or an out-of-range lead index into a NULL foreign key and a confusing constraint
 * error a hundred lines later.
 */
const userId: Record<string, number> = {};
const leadId: number[] = [];

function uid(key: string): number {
  const id = userId[key];
  if (id === undefined) throw new Error(`No seeded employee with key "${key}".`);
  return id;
}

function lid(index: number): number {
  const id = leadId[index];
  if (id === undefined) {
    throw new Error(`No seeded lead at index ${index} (only ${leadId.length} exist).`);
  }
  return id;
}

function lead(index: number): SeedLead {
  const row = LEADS[index];
  if (!row) throw new Error(`No lead defined at index ${index}.`);
  return row;
}

function userName(key: string): string {
  const row = USERS.find((u) => u.key === key);
  if (!row) throw new Error(`No seed user with key "${key}".`);
  return row.name;
}

async function main(): Promise<void> {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'jmk',
    /* Same as src/db/pool.ts — see the note on sql() above. */
    timezone: 'Z',
    multipleStatements: false,
  });

  /*
   * The session zone, matching `src/db/pool.ts`.
   *
   * The driver option on the connection above only governs how the driver converts
   * values. `NOW()` and `CURDATE()` are evaluated inside MySQL against the session zone,
   * so without this the verification counts printed at the end are computed on the
   * server's local clock while the application computes them in UTC. The two then
   * disagree: this script reported 7 overdue follow-ups where the API correctly
   * reported 2.
   */
  await db.query("SET time_zone = '+00:00'");

  console.log(`Seeding telecalling demo data into "${process.env.DB_NAME ?? 'jmk'}"…\n`);

  /*
   * Cleared in dependency order rather than with FK checks disabled, so that a missing
   * ON DELETE rule shows up here as an error instead of leaving orphans behind.
   * `enquiries`, `job_applications` and `admin_users` are untouched by design.
   */
  for (const table of [
    'call_recordings',
    'notifications',
    'lead_activities',
    'lead_notes',
    'follow_ups',
    'calls',
    'leads',
    'mobile_sessions',
    'telecaller_users',
  ]) {
    await db.execute(`DELETE FROM ${table}`);
  }
  await db.execute("DELETE FROM audit_logs WHERE actor_type IN ('employee','system')");

  /* ------------------------------------------------------------- people */

  const hash = await bcrypt.hash(password, 10);

  for (const u of USERS) {
    const registered = u.approval === 'approved' ? null : sql(shift({ days: -2 }));
    const [res] = await db.execute(
      `INSERT INTO telecaller_users
         (employee_code, name, email, phone, password_hash, role, availability,
          is_active, approval_status, registered_at, approved_at, rejection_reason,
          last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        u.code,
        u.name,
        u.email,
        u.phone,
        hash,
        u.role,
        u.availability,
        u.active ? 1 : 0,
        u.approval,
        registered,
        u.approval === 'approved' ? sql(shift({ days: -30 })) : null,
        u.rejectionReason ?? null,
        u.approval === 'approved' && u.active ? sql(shift({ hours: -3 })) : null,
      ],
    );
    userId[u.key] = (res as mysql.ResultSetHeader).insertId;
  }

  /*
   * The real administrator, if one is configured and is not already in the cast above.
   * Given the `admin` role so every panel and every role gate is reachable.
   */
  let linkedAdmin: string | null = null;

  if (ADMIN_LOGIN_EMAIL && !USERS.some((u) => u.email === ADMIN_LOGIN_EMAIL)) {
    const [res] = await db.execute(
      `INSERT INTO telecaller_users
         (employee_code, name, email, password_hash, role, availability,
          is_active, approval_status, approved_at)
       VALUES (?, ?, ?, ?, 'admin', 'available', 1, 'approved', ?)`,
      ['TC-1000', 'Administrator', ADMIN_LOGIN_EMAIL, hash, sql(shift({ days: -30 }))],
    );
    userId.websiteAdmin = (res as mysql.ResultSetHeader).insertId;
    linkedAdmin = ADMIN_LOGIN_EMAIL;
  }

  // Recorded now that the admin's id exists.
  await db.execute(
    `UPDATE telecaller_users SET approved_by = ?
      WHERE approval_status = 'approved' AND id <> ?`,
    [uid('admin'), uid('admin')],
  );

  console.log(`  ${USERS.length + (linkedAdmin ? 1 : 0)} employees`);
  if (linkedAdmin) {
    console.log(`      linked the admin portal account ${linkedAdmin} as role=admin`);
  } else if (!ADMIN_LOGIN_EMAIL) {
    console.log('      WARNING: ADMIN_LOGIN_EMAIL is not set, so the admin portal');
    console.log('               will report "not set up for the telecalling system".');
  }
  console.log(`      approved  ${USERS.filter((u) => u.approval === 'approved').length}`);
  console.log(`      pending   ${USERS.filter((u) => u.approval === 'pending').length}`);
  console.log(`      rejected  ${USERS.filter((u) => u.approval === 'rejected').length}`);

  /* -------------------------------------------------------------- leads */

  for (const l of LEADS) {
    const created = sql(shift({ days: -l.createdDaysAgo, hours: -2 }));
    const owner = l.owner ? uid(l.owner) : null;

    const [res] = await db.execute(
      `INSERT INTO leads
         (reference, customer_name, phone, alternate_phone, email, address, city, source,
          product_interest, status, assigned_to, assigned_at, assigned_by, created_by,
          summary_note, converted_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reference('LD'),
        l.name,
        l.phone,
        null,
        l.email,
        l.address,
        l.city,
        l.source,
        l.product,
        l.status,
        owner,
        owner ? created : null,
        owner ? uid('admin') : null,
        uid('admin'),
        l.summary,
        l.status === 'converted' ? sql(shift({ days: -Math.floor(l.createdDaysAgo / 3) })) : null,
        created,
      ],
    );
    leadId.push((res as mysql.ResultSetHeader).insertId);
  }

  console.log(`\n  ${LEADS.length} leads`);
  const byStatus = LEADS.reduce<Record<string, number>>((acc, l) => {
    acc[l.status] = (acc[l.status] ?? 0) + 1;
    return acc;
  }, {});
  for (const [status, count] of Object.entries(byStatus).sort()) {
    console.log(`      ${status.padEnd(20)}${count}`);
  }

  /* -------------------------------------------------------------- calls */

  /**
   * Outcomes are assigned by lead status, not at random, so the data tells a coherent
   * story: a converted lead has answered calls behind it, a not_reachable lead has
   * nothing but no_answer and unreachable.
   *
   * `missed` is included explicitly. It is the one outcome no client path currently
   * produces, so the dashboard's Missed tile reads zero on real data — seeding it is the
   * only way to see whether that tile is wired up at all.
   */
  const OUTCOMES_BY_STATUS: Record<string, string[]> = {
    new: [],
    contacted: ['answered'],
    interested: ['answered', 'answered'],
    follow_up: ['answered', 'no_answer'],
    callback_requested: ['answered', 'busy'],
    converted: ['answered', 'answered', 'answered'],
    not_interested: ['answered'],
    lost: ['answered', 'answered', 'no_answer'],
    invalid_number: ['unreachable'],
    not_reachable: ['no_answer', 'no_answer', 'unreachable', 'missed'],
  };

  let calls = 0;
  const outcomeTally: Record<string, number> = {};

  for (const [index, l] of LEADS.entries()) {
    const outcomes = OUTCOMES_BY_STATUS[l.status] ?? [];
    const owner = l.owner ? uid(l.owner) : uid('ravi');

    for (const [n, outcome] of outcomes.entries()) {
      // Spread backwards from the lead's creation so history reads chronologically.
      const startedAt = shift({ days: -l.createdDaysAgo + n, hours: 9 + n * 2 });
      if (startedAt > now) startedAt.setTime(shift({ hours: -1 - n }).getTime());

      const duration = outcome === 'answered' ? 95 + ((index * 37 + n * 53) % 400) : 0;

      const [res] = await db.execute(
        `INSERT INTO calls
           (client_uuid, lead_id, user_id, phone, direction, outcome, channel, source,
            duration_seconds, started_at, ended_at, followed_up)
         VALUES (?, ?, ?, ?, 'outgoing', ?, 'device', ?, ?, ?, ?, ?)`,
        [
          uuid(),
          lid(index),
          owner,
          l.phone,
          outcome,
          outcome === 'missed' ? 'call_log' : 'manual',
          duration,
          sql(startedAt),
          sql(new Date(startedAt.getTime() + duration * 1000)),
          outcome === 'answered' && n === outcomes.length - 1 ? 1 : 0,
        ],
      );
      calls += 1;
      outcomeTally[outcome] = (outcomeTally[outcome] ?? 0) + 1;

      if (outcome === 'answered') {
        await db.execute(
          `INSERT INTO lead_notes (lead_id, user_id, kind, body, call_id, client_uuid, created_at)
           VALUES (?, ?, 'call_note', ?, ?, ?, ?)`,
          [
            lid(index),
            owner,
            n === 0
              ? 'First contact made. Explained the product range and pricing.'
              : 'Follow-up conversation. Answered questions on delivery and warranty.',
            (res as mysql.ResultSetHeader).insertId,
            uuid(),
            sql(startedAt),
          ],
        );
      }
    }
  }

  /* Two `rejected` calls, which no status above generates, so all six outcomes exist. */
  for (const [n, key] of ['ravi', 'mira'].entries()) {
    await db.execute(
      `INSERT INTO calls
         (client_uuid, lead_id, user_id, phone, direction, outcome, channel, source,
          duration_seconds, started_at, ended_at, followed_up)
       VALUES (?, ?, ?, ?, 'outgoing', 'rejected', 'device', 'manual', 0, ?, ?, 0)`,
      [
        uuid(),
        lid(6 + n),
        uid(key),
        lead(6 + n).phone,
        sql(shift({ days: -2, hours: 11 + n })),
        sql(shift({ days: -2, hours: 11 + n })),
      ],
    );
    calls += 1;
    outcomeTally.rejected = (outcomeTally.rejected ?? 0) + 1;
  }

  /**
   * Today's calls, added explicitly.
   *
   * Every call above is backdated relative to its lead's age, so none of them land
   * today — which leaves the dashboard's "today" tiles (calls, answered, missed, talk
   * time) reading zero, indistinguishable from a broken query. These sit a few hours
   * back: inside today's window, never in the future.
   *
   * One of them is `missed` on purpose. That is the only outcome no client path
   * produces, so this is the row that proves the Missed tile is wired to the data at all.
   */
  const TODAY_CALLS: Array<{
    owner: string;
    leadIndex: number;
    outcome: string;
    hoursAgo: number;
    duration: number;
  }> = [
    { owner: 'ravi', leadIndex: 5, outcome: 'answered', hoursAgo: 6, duration: 342 },
    { owner: 'ravi', leadIndex: 9, outcome: 'answered', hoursAgo: 5, duration: 208 },
    { owner: 'ravi', leadIndex: 12, outcome: 'no_answer', hoursAgo: 4, duration: 0 },
    { owner: 'ravi', leadIndex: 15, outcome: 'missed', hoursAgo: 3, duration: 0 },
    { owner: 'ravi', leadIndex: 17, outcome: 'answered', hoursAgo: 2, duration: 511 },
    { owner: 'mira', leadIndex: 6, outcome: 'answered', hoursAgo: 5, duration: 275 },
    { owner: 'mira', leadIndex: 10, outcome: 'answered', hoursAgo: 3, duration: 430 },
    { owner: 'mira', leadIndex: 13, outcome: 'busy', hoursAgo: 2, duration: 0 },
    { owner: 'sanjay', leadIndex: 11, outcome: 'answered', hoursAgo: 4, duration: 190 },
    { owner: 'sanjay', leadIndex: 16, outcome: 'missed', hoursAgo: 1, duration: 0 },
    { owner: 'deepa', leadIndex: 14, outcome: 'no_answer', hoursAgo: 3, duration: 0 },
    { owner: 'deepa', leadIndex: 19, outcome: 'answered', hoursAgo: 2, duration: 366 },
  ];

  for (const t of TODAY_CALLS) {
    const startedAt = shift({ hours: -t.hoursAgo });
    const [res] = await db.execute(
      `INSERT INTO calls
         (client_uuid, lead_id, user_id, phone, direction, outcome, channel, source,
          duration_seconds, started_at, ended_at, followed_up)
       VALUES (?, ?, ?, ?, 'outgoing', ?, 'device', ?, ?, ?, ?, 0)`,
      [
        uuid(),
        lid(t.leadIndex),
        uid(t.owner),
        lead(t.leadIndex).phone,
        t.outcome,
        t.outcome === 'missed' ? 'call_log' : 'manual',
        t.duration,
        sql(startedAt),
        sql(new Date(startedAt.getTime() + t.duration * 1000)),
      ],
    );
    calls += 1;
    outcomeTally[t.outcome] = (outcomeTally[t.outcome] ?? 0) + 1;

    if (t.outcome === 'answered') {
      await db.execute(
        `INSERT INTO lead_notes (lead_id, user_id, kind, body, call_id, client_uuid, created_at)
         VALUES (?, ?, 'call_note', ?, ?, ?, ?)`,
        [
          lid(t.leadIndex),
          uid(t.owner),
          'Spoke today. Confirmed requirements and agreed the next step.',
          (res as mysql.ResultSetHeader).insertId,
          uuid(),
          sql(startedAt),
        ],
      );
    }
  }

  console.log(`\n  ${calls} calls`);
  for (const [outcome, count] of Object.entries(outcomeTally).sort()) {
    console.log(`      ${outcome.padEnd(20)}${count}`);
  }

  /* --------------------------------------------------------- follow-ups */

  /**
   * Overdue, today, upcoming, completed, cancelled.
   *
   * "Overdue" is derived at read time from `due_at < NOW() AND state = 'pending'` rather
   * than stored, so the only way to test it is to have rows genuinely in the past.
   */
  type SeedFollowUp = {
    leadIndex: number;
    owner: string;
    due: Date;
    note: string;
    state: 'pending' | 'completed' | 'cancelled';
  };

  const FOLLOW_UPS: SeedFollowUp[] = [
    // Overdue.
    { leadIndex: 12, owner: 'ravi', due: shift({ days: -3, hours: 10 }), note: 'Call back after the board meeting.', state: 'pending' },
    { leadIndex: 13, owner: 'mira', due: shift({ days: -2, hours: 15 }), note: 'They asked for a call this week.', state: 'pending' },
    { leadIndex: 14, owner: 'deepa', due: shift({ days: -1, hours: 11 }), note: 'Second attempt at reaching the purchase officer.', state: 'pending' },
    { leadIndex: 5, owner: 'ravi', due: shift({ hours: -4 }), note: 'Send the written quotation as promised.', state: 'pending' },
    // Due today.
    { leadIndex: 15, owner: 'ravi', due: todayAt(18, 30), note: 'Requested a call after 6pm.', state: 'pending' },
    { leadIndex: 9, owner: 'ravi', due: todayAt(16, 0), note: 'Deliver the full catalogue.', state: 'pending' },
    { leadIndex: 16, owner: 'sanjay', due: todayAt(20, 0), note: 'Was in a meeting; try this evening.', state: 'pending' },
    // Upcoming.
    { leadIndex: 10, owner: 'mira', due: shift({ days: 1, hours: 4 }), note: 'Speak to the medical director.', state: 'pending' },
    { leadIndex: 11, owner: 'sanjay', due: shift({ days: 2 }), note: 'Arrange the on-site demonstration.', state: 'pending' },
    { leadIndex: 6, owner: 'mira', due: shift({ days: 3 }), note: 'Check whether they have compared suppliers.', state: 'pending' },
    { leadIndex: 7, owner: 'sanjay', due: shift({ days: 5 }), note: 'Confirm the consumables list.', state: 'pending' },
    { leadIndex: 8, owner: 'deepa', due: shift({ days: 6 }), note: 'Follow up on the trade fair enquiry.', state: 'pending' },
    // Closed out.
    { leadIndex: 17, owner: 'ravi', due: shift({ days: -6 }), note: 'Final paperwork for the signed order.', state: 'completed' },
    { leadIndex: 18, owner: 'mira', due: shift({ days: -9 }), note: 'Confirm the financing terms.', state: 'completed' },
    { leadIndex: 19, owner: 'deepa', due: shift({ days: -12 }), note: 'Set up the monthly delivery schedule.', state: 'completed' },
    { leadIndex: 20, owner: 'ravi', due: shift({ days: -4 }), note: 'No longer required — under contract elsewhere.', state: 'cancelled' },
    { leadIndex: 22, owner: 'sanjay', due: shift({ days: -5 }), note: 'Lead lost to a competitor.', state: 'cancelled' },
  ];

  const stateTally: Record<string, number> = {};

  for (const f of FOLLOW_UPS) {
    await db.execute(
      `INSERT INTO follow_ups
         (lead_id, assigned_to, created_by, due_at, note, state, completed_at,
          completed_by, outcome_note, client_uuid, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        lid(f.leadIndex),
        uid(f.owner),
        uid(f.owner),
        sql(f.due),
        f.note,
        f.state,
        f.state === 'completed' ? sql(shift({ days: -1 })) : null,
        f.state === 'completed' ? uid(f.owner) : null,
        f.state === 'completed' ? 'Done — customer confirmed.' : null,
        uuid(),
        sql(shift({ days: -7 })),
      ],
    );
    stateTally[f.state] = (stateTally[f.state] ?? 0) + 1;
  }

  const overdue = FOLLOW_UPS.filter((f) => f.state === 'pending' && f.due < now).length;
  const dueToday = FOLLOW_UPS.filter(
    (f) => f.state === 'pending' && f.due >= now && f.due <= todayAt(23, 59),
  ).length;

  console.log(`\n  ${FOLLOW_UPS.length} follow-ups`);
  for (const [state, count] of Object.entries(stateTally).sort()) {
    console.log(`      ${state.padEnd(20)}${count}`);
  }
  console.log(`      (of pending: ${overdue} overdue, ${dueToday} due later today)`);

  /* ------------------------------------------------- notes and activity */

  let notes = 0;

  for (const [index, l] of LEADS.entries()) {
    if (!l.summary) continue;
    await db.execute(
      `INSERT INTO lead_notes (lead_id, user_id, kind, body, client_uuid, created_at)
       VALUES (?, ?, 'requirement', ?, ?, ?)`,
      [
        lid(index),
        l.owner ? uid(l.owner) : uid('admin'),
        l.summary,
        uuid(),
        sql(shift({ days: -l.createdDaysAgo, hours: 1 })),
      ],
    );
    notes += 1;
  }

  let activities = 0;

  for (const [index, l] of LEADS.entries()) {
    const owner = l.owner ? uid(l.owner) : uid('admin');
    const created = sql(shift({ days: -l.createdDaysAgo, hours: -2 }));

    await db.execute(
      `INSERT INTO lead_activities (lead_id, user_id, type, summary, meta, created_at)
       VALUES (?, ?, 'created', ?, ?, ?)`,
      [lid(index), uid('admin'), `Lead created from ${l.source}`, JSON.stringify({ source: l.source }), created],
    );
    activities += 1;

    if (l.owner) {
      await db.execute(
        `INSERT INTO lead_activities (lead_id, user_id, type, summary, meta, created_at)
         VALUES (?, ?, 'assigned', ?, ?, ?)`,
        [lid(index), uid('admin'), `Assigned to ${userName(l.owner)}`, JSON.stringify({ assignedTo: owner }), created],
      );
      activities += 1;
    }

    if (l.status !== 'new') {
      await db.execute(
        `INSERT INTO lead_activities (lead_id, user_id, type, summary, meta, created_at)
         VALUES (?, ?, 'status_changed', ?, ?, ?)`,
        [
          lid(index),
          owner,
          `Status set to ${l.status.replace(/_/g, ' ')}`,
          JSON.stringify({ from: 'new', to: l.status }),
          sql(shift({ days: -Math.max(0, l.createdDaysAgo - 1) })),
        ],
      );
      activities += 1;
    }
  }

  console.log(`\n  ${notes} requirement notes, ${activities} activity entries`);

  /* ------------------------------------------------------ notifications */

  const NOTIFICATIONS: Array<{
    owner: string;
    kind: string;
    title: string;
    body: string;
    leadIndex: number | null;
    read: boolean;
    agoHours: number;
  }> = [
    { owner: 'ravi', kind: 'lead_assigned', title: 'New lead assigned', body: 'Suresh Babu — Medical equipment financing', leadIndex: 0, read: false, agoHours: 1 },
    { owner: 'ravi', kind: 'followup_due', title: 'Follow-up due today', body: 'Meenakshi Sundaram asked for a call after 6pm.', leadIndex: 15, read: false, agoHours: 2 },
    { owner: 'ravi', kind: 'followup_overdue', title: 'Follow-up overdue', body: 'Ramesh Gupta — 3 days late.', leadIndex: 12, read: false, agoHours: 5 },
    { owner: 'ravi', kind: 'lead_assigned', title: 'New lead assigned', body: 'Lakshmi Menon — Hospital consumables', leadIndex: 1, read: true, agoHours: 26 },
    { owner: 'mira', kind: 'followup_overdue', title: 'Follow-up overdue', body: 'Aishwarya Rao — 2 days late.', leadIndex: 13, read: false, agoHours: 4 },
    { owner: 'mira', kind: 'lead_assigned', title: 'New lead assigned', body: 'Anand Krishnan — Diagnostic lab setup', leadIndex: 2, read: true, agoHours: 30 },
    { owner: 'sanjay', kind: 'followup_due', title: 'Follow-up due today', body: 'Imran Qureshi — try this evening.', leadIndex: 16, read: false, agoHours: 3 },
    { owner: 'deepa', kind: 'followup_overdue', title: 'Follow-up overdue', body: 'Joseph Mathew — 1 day late.', leadIndex: 14, read: false, agoHours: 20 },
    { owner: 'deepa', kind: 'lead_assigned', title: 'New lead assigned', body: 'Prakash Nayak — Diagnostic lab setup', leadIndex: 8, read: true, agoHours: 48 },
  ];

  for (const n of NOTIFICATIONS) {
    await db.execute(
      `INSERT INTO notifications (user_id, kind, title, body, lead_id, read_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        uid(n.owner),
        n.kind,
        n.title,
        n.body,
        n.leadIndex === null ? null : lid(n.leadIndex),
        n.read ? sql(shift({ hours: -n.agoHours + 1 })) : null,
        sql(shift({ hours: -n.agoHours })),
      ],
    );
  }

  console.log(
    `  ${NOTIFICATIONS.length} notifications (${NOTIFICATIONS.filter((n) => !n.read).length} unread)`,
  );

  /* --------------------------------------------------------- audit trail */

  await db.execute(
    `INSERT INTO audit_logs (actor_type, actor_id, actor_label, action, entity_type, entity_id, summary, meta)
     VALUES ('system', NULL, 'demo seed', 'demo_seeded', 'system', NULL, ?, ?)`,
    [
      `Seeded ${LEADS.length} leads, ${calls} calls and ${FOLLOW_UPS.length} follow-ups`,
      JSON.stringify({ seededAt: sql(now), employees: USERS.length }),
    ],
  );

  /* ------------------------------------------------------------- caches */

  /*
   * The exact statement from `refreshLeadCachesTx`, replayed for every lead rather than
   * reimplemented. Copying the logic here would be a second definition of "most recent
   * contact", and the two would drift.
   */
  await db.execute(
    `UPDATE leads l
        SET l.last_contacted_at = (
              SELECT MAX(c.started_at) FROM calls c
               WHERE c.lead_id = l.id AND c.outcome = 'answered'
            ),
            l.next_follow_up_at = (
              SELECT MIN(f.due_at) FROM follow_ups f
               WHERE f.lead_id = l.id AND f.state = 'pending'
            )`,
  );

  /* ------------------------------------------------------------- report */

  const [rows] = (await db.query(
    `SELECT
       (SELECT COUNT(*) FROM telecaller_users)                                    AS employees,
       (SELECT COUNT(*) FROM telecaller_users WHERE approval_status = 'pending')   AS pending,
       (SELECT COUNT(*) FROM leads)                                               AS leads,
       (SELECT COUNT(*) FROM leads WHERE assigned_to IS NULL)                     AS unassigned,
       (SELECT COUNT(*) FROM calls)                                               AS calls,
       (SELECT COUNT(*) FROM calls WHERE outcome = 'missed')                      AS missed,
       (SELECT COUNT(*) FROM calls WHERE DATE(started_at) = CURDATE())            AS calls_today,
       (SELECT COUNT(*) FROM calls
         WHERE DATE(started_at) = CURDATE() AND outcome = 'missed')               AS missed_today,
       (SELECT COUNT(*) FROM follow_ups WHERE state = 'pending' AND due_at < NOW()) AS overdue,
       (SELECT COUNT(*) FROM lead_notes)                                          AS notes,
       (SELECT COUNT(*) FROM notifications WHERE read_at IS NULL)                 AS unread,
       (SELECT COUNT(*) FROM leads WHERE last_contacted_at IS NOT NULL)           AS contacted_cache,
       (SELECT COUNT(*) FROM leads WHERE next_follow_up_at IS NOT NULL)           AS followup_cache`,
  )) as [Array<Record<string, number>>, unknown];

  /* One row, always — every column is a scalar subquery — but the index is still checked. */
  const counts = rows[0] ?? {};

  console.log('\nverified in the database:');
  for (const [key, value] of Object.entries(counts)) {
    console.log(`   ${key.padEnd(18)}${value}`);
  }

  await db.end();

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('  Sign in with any of these — the password is the same for all');
  console.log('──────────────────────────────────────────────────────────────');
  for (const u of USERS.filter((x) => x.approval === 'approved' && x.active)) {
    console.log(`   ${u.role.padEnd(11)} ${u.email.padEnd(38)} ${u.code}`);
  }
  console.log('\n   Awaiting approval (use these to test the admin queue):');
  for (const u of USERS.filter((x) => x.approval === 'pending')) {
    console.log(`   ${''.padEnd(11)} ${u.email.padEnd(38)} ${u.code}`);
  }
  if (linkedAdmin) {
    console.log('\n   Admin portal (http://localhost:3000/admin/login/):');
    console.log(`   ${''.padEnd(11)} ${linkedAdmin.padEnd(38)} TC-1000`);
    console.log(`   ${''.padEnd(11)} web sign-in uses ADMIN_PASSWORD_HASH, not the password below`);
  }

  console.log(`\n   password:  ${password}`);
  if (!process.env.SEED_DEMO_PASSWORD) {
    console.log('   (generated — set SEED_DEMO_PASSWORD to choose your own)');
  }
  console.log('');
}

main().catch((error: unknown) => {
  console.error('\nSeed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
