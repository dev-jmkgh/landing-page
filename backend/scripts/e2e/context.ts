/**
 * What the e2e harness hands to each section file in `scripts/e2e/`.
 *
 * The harness (`scripts/e2e-telecalling.ts`) runs its own linear sections first, then
 * calls each file here in a fixed order — `foundation`, `calls`, `dashboard`, `leads`,
 * `people`, `dailyReport`, `leadImport` — as `run(ctx)`, at the very end of the run. A
 * section that throws is reported as one FAIL and the next section still runs.
 *
 * RULES FOR A SECTION FILE
 *
 * - Type-only imports at the top. A static import of anything that reaches
 *   `src/config/env.ts` — the pool, a repository, a service, the app — is hoisted above
 *   the harness's environment overrides when the file is loaded first, freezes the REAL
 *   database name, and runs against the developer's database. Load app modules with
 *   `await import(...)` inside `run`. (The harness itself loads these files dynamically,
 *   after its overrides, so a slip here is not fatal — but do not rely on that.)
 * - Build your own fixtures with `createSignedInEmployee` and unique emails, phone
 *   numbers and company numbers. Do not reuse ravi or mira for writes another section
 *   counts on, and assert deltas or entity-scoped results, not global totals: every
 *   earlier section has already written rows.
 * - Use `UTC_TIMESTAMP()`, never `NOW()`, in SQL sent through `db` — its session is the
 *   server's zone (IST), not UTC. Or use `utcDb`, which is pinned to UTC like the app.
 * - Guard every read of a response body with `?.` and `?? fallback`; a thrown TypeError
 *   ends the section. `check`'s condition must be a real boolean (`?? false`).
 * - Real mail is off for the whole run (SMTP credentials are blanked before the app
 *   loads), so a feature that emails must also leave a database trace to assert on.
 * - Rate limits that are NOT lifted are shared by the whole run from one IP — notably
 *   the 240-per-minute mobile write limiter. Keep mobile writes proportionate.
 */
import type { Connection } from 'mysql2/promise';
import type { EmployeeRole } from '../../src/modules/telecalling/shared.schema';

/** A parsed JSON response body. Loose on purpose: assertions probe it with `?.`. */
export type Json = Record<string, any>;

/** A JSON API response. A body that is not JSON arrives as `{ raw: <first 200 chars> }`. */
export type ApiResponse = { status: number; json: Json; headers: Headers };

/** A response read as bytes — file downloads such as the import template. */
export type RawResponse = { status: number; headers: Headers; body: Buffer };

/**
 * An HTTP client for the app under test. Paths are relative to `/api`, e.g.
 * `'/mobile/leads'` or `'/admin/telecalling/dashboard'`. Redirects are not followed.
 */
export interface Client {
  /**
   * Any method. `headers` are applied last, so they can override the defaults —
   * `Cookie` and `X-CSRF-Token` for the admin cookie path, `Origin` for CORS.
   */
  call(
    method: string,
    pathname: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<ApiResponse>;
  /** A multipart request. Content-Type (with its boundary) is set by fetch, not here. */
  callForm(method: string, pathname: string, form: FormData): Promise<ApiResponse>;
  /** A GET whose body is returned as bytes rather than parsed. */
  getRaw(pathname: string): Promise<RawResponse>;
  /** Sends `Authorization: Bearer <token>` from now on; null stops sending it. */
  setToken(token: string | null): void;
  get(pathname: string): Promise<ApiResponse>;
  post(pathname: string, body?: unknown): Promise<ApiResponse>;
  patch(pathname: string, body?: unknown): Promise<ApiResponse>;
  put(pathname: string, body?: unknown): Promise<ApiResponse>;
  del(pathname: string, body?: unknown): Promise<ApiResponse>;
}

export type CreateEmployeeOptions = {
  name: string;
  /** Must be unique across the run. */
  email: string;
  role: EmployeeRole;
  /**
   * Canonical `+91XXXXXXXXXX`, unique among live staff, or null/omitted for none.
   * Written as given — it is a fixture, not validated input.
   */
  companyPhone?: string | null;
  /**
   * Employee code. Defaults to the next `FX-####`, a series no other path generates;
   * never pass a `TC-####` code, which would shift the sequence the API allocates.
   */
  code?: string;
};

export type E2EContext = {
  /** The API root, `http://127.0.0.1:<port>/api`. */
  base: string;
  /** The harness's own connection to the scratch database. Session zone: the server's (IST). */
  db: Connection;
  /**
   * A second connection pinned to UTC exactly like the app's pool (driver timezone 'Z'
   * and `SET time_zone = '+00:00'`), for fixtures written with JS Dates or `NOW()`.
   */
  utcDb: Connection;
  /** Records one assertion. Never throws. */
  check: (label: string, condition: boolean, detail?: unknown) => void;
  makeClient: (base: string) => Client;

  /** The seeded admin, signed in through the mobile login (a Bearer token, no CSRF). */
  adminAsBearer: Client;
  adminId: number;
  /** Seeded telecaller, company number +919876500002. His refresh token was revoked by
   *  the sign-out section; his access token still works. */
  ravi: Client;
  raviId: number;
  /** Seeded telecaller, company number +919876500003. DEACTIVATED by the time sections
   *  run, so her company number is free again. Her access token still works. */
  mira: Client;
  miraId: number;

  /**
   * Inserts an approved, active, email-verified employee straight into the database and
   * signs them in through the mobile login. The password is the seed password.
   */
  createSignedInEmployee: (
    options: CreateEmployeeOptions,
  ) => Promise<{ client: Client; id: number; refreshToken: string }>;
};
