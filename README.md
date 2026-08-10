# JMK Global Holdings — corporate website

Production website for **JMK Global Holdings**, a diversified business group headquartered
in Coimbatore, Tamil Nadu, operating across education, engineering design, software
development, exports, agriculture, renewable energy and real estate.

**Production:** https://www.jmkglobalholdings.com

| | |
| --- | --- |
| Website | Next.js 15 (App Router), exported as static HTML — runs on any Hostinger plan |
| API | Node.js + Express + MySQL — enquiries, career applications, admin |
| Email | Gmail SMTP via Nodemailer (App Password, from the environment) |
| Deployment | GitHub → Hostinger (`public_html` for the site, a Node app on `api.` for the API) |

---

## Contents

1. [Project overview](#1-project-overview)
2. [Tech stack](#2-tech-stack)
3. [Folder structure](#3-folder-structure)
4. [Local setup](#4-local-setup)
5. [Database setup](#5-database-setup)
6. [Environment variables](#6-environment-variables)
7. [Gmail SMTP setup](#7-gmail-smtp-setup)
8. [Development commands](#8-development-commands)
9. [Production build](#9-production-build)
10. [Hostinger deployment](#10-hostinger-deployment)
11. [Domain and HTTPS](#11-domain-and-https)
12. [Editing site content](#12-editing-site-content)
13. [Security notes](#13-security-notes)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Project overview

Eleven public pages, a persistent enquiry widget, a career application form with resume
upload, and a protected admin area for handling what comes in.

| Route | Page |
| --- | --- |
| `/` | Home |
| `/about` | About Us |
| `/business` | Our Business |
| `/business/jmk-academy` | JMK Academy — CAD DESK, SAP, Zoho Book |
| `/business/jmk-design-studio` | JMK Design Studio — all CAD designing works |
| `/business/jmk-software-solutions` | JMK Software Solutions |
| `/gallery` | Gallery |
| `/careers` | Careers + application form |
| `/contact` | Contact Us |
| `/privacy-policy`, `/terms` | Legal |
| `/admin/enquiries` | Admin (authentication required, excluded from search engines) |

### Content integrity

Every factual claim on this website comes from the supplied content document. The
extraction lives in **[`docs/content-map.md`](docs/content-map.md)** and the machine-readable
version in `frontend/src/lib/content/`.

Nothing else is invented — no clients, awards, certifications, employee counts, revenue
figures, testimonials or extra offices. Where the document supplied no detail (gallery
photography, real estate services, the YouTube URL), the site shows a branded placeholder
or omits the item rather than filling the gap with fiction. Keep it that way when you
edit: if a fact is not in the content map, it does not belong on the site.

---

## 2. Tech stack

**Frontend**

- Next.js 15 (App Router) with `output: 'export'` — the build produces plain HTML, CSS
  and JS. No Node.js runtime is needed to serve the website, which is what makes it work
  on standard Hostinger hosting.
- React 19, TypeScript in strict mode.
- Hand-written CSS with design tokens (`frontend/src/styles/tokens.css`). No CSS
  framework, no component library, no icon package — the icon set is inline SVG.
- Motion is CSS transitions driven by a small IntersectionObserver hook, and it honours
  `prefers-reduced-motion`.

**Backend**

- Express 4 on Node 18+, TypeScript.
- MySQL through `mysql2` with bound parameters everywhere.
- Zod for request validation, Helmet for headers, `express-rate-limit` for throttling,
  Multer for uploads, bcrypt for password hashing, JWT (HttpOnly cookie) plus a
  double-submit CSRF token for the admin session.
- Nodemailer for Gmail SMTP.

JavaScript is limited to the genuinely interactive surfaces: the header and mobile drawer,
the enquiry widget and its forms, the careers application form, the gallery filter, the
scroll-reveal and counter helpers, and the admin screen. Page content itself is
pre-rendered HTML — the homepage ships roughly 116 KB of JavaScript in total.

---

## 3. Folder structure

```
landing-page/
├── frontend/                     Next.js website (static export)
│   ├── public/
│   │   ├── .htaccess             Apache config — deployed with the site
│   │   └── images/               Image slots (guide: docs/image-assets.md)
│   ├── scripts/
│   │   └── generate-og-image.mjs Builds the 1200×630 social card
│   └── src/
│       ├── app/
│       │   ├── (site)/           Public pages (header/footer chrome)
│       │   ├── (admin)/          Admin area (no marketing chrome)
│       │   ├── layout.tsx        Fonts, base metadata
│       │   ├── sitemap.ts        → /sitemap.xml
│       │   └── robots.ts         → /robots.txt
│       ├── components/
│       │   ├── admin/  business/  contact/  enquiry/
│       │   ├── forms/            Field primitives + the two forms
│       │   ├── gallery/  home/  layout/  ui/
│       ├── hooks/
│       ├── lib/
│       │   ├── content/          ALL site copy (the source of truth for text)
│       │   ├── api.ts            Centralised API client
│       │   ├── seo.ts            Metadata + JSON-LD builders
│       │   ├── site.ts           Company identity, contact details, navigation
│       │   └── validation.ts     Client-side validation
│       └── styles/               tokens · base · layout · components · pages
│
├── backend/                      Express API — self-contained, including its schema
│   ├── database/migrations/      Versioned SQL, applied in filename order
│   ├── scripts/hash-password.mjs
│   └── src/
│       ├── config/env.ts         Validated environment configuration
│       ├── db/                   Pool, migration runner, seeder
│       ├── middleware/           security · rateLimit · auth · upload · validate · errors
│       ├── modules/
│       │   ├── admin/            Auth service + admin routes
│       │   ├── applications/     schema · repository · service · routes
│       │   └── enquiries/        schema · repository · service · routes
│       ├── services/             mailer · email templates
│       ├── utils/
│       ├── app.ts                Express wiring
│       └── server.ts             Entry point
│
├── docs/
│   ├── content-map.md            Extracted source content — the factual authority
│   ├── deployment-hostinger.md   Step-by-step deployment
│   ├── api-reference.md          Endpoint documentation
│   ├── image-assets.md           How to replace the image placeholders
│   └── testing-checklist.md      Release checklist
├── .github/workflows/deploy.yml  Build + FTPS publish
├── .env.example                  Every variable, documented in one place
└── README.md
```

---

## 4. Local setup

**Requirements:** Node.js 18.18 or newer, npm 9+, MySQL 8 (or MariaDB 10.6+).

```bash
git clone https://github.com/dev-jmkgh/landing-page.git
cd landing-page
npm install                # root tooling (concurrently)
npm run install:all        # frontend + backend dependencies
```

Create the two environment files:

```bash
cp frontend/.env.example frontend/.env.local
cp backend/.env.example  backend/.env
```

Fill in the database credentials in `backend/.env`, then:

```bash
npm run db:migrate         # create the tables
npm run dev                # website on :3000, API on :5000
```

The API starts even when MySQL or SMTP is unavailable — it reports the problem at
startup and keeps answering health checks, so you can work on the site first and wire up
the database later.

---

## 5. Database setup

```sql
CREATE DATABASE jmk_global CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'jmk_user'@'localhost' IDENTIFIED BY 'a-strong-password';
GRANT SELECT, INSERT, UPDATE, DELETE ON jmk_global.* TO 'jmk_user'@'localhost';
FLUSH PRIVILEGES;
```

The application user needs no DDL rights at runtime; grant `CREATE` temporarily if you
want the migration runner to build the tables under that user.

```bash
npm run db:migrate         # applies backend/database/migrations/*.sql, once each
```

The runner records a checksum per file, so an already-applied migration that is later
edited is reported rather than silently skipped. Add changes as new numbered files.

> **Why the SQL lives in `backend/database/`.** The schema belongs to the service that
> owns it. Keeping it inside `backend/` means the API folder is self-contained: deploying
> the backend brings its migrations along, `npm run db:migrate:prod` finds them with no
> configuration, and there is no separate top-level folder to remember to upload. Set
> `MIGRATIONS_DIR` to an absolute path if you ever need to override the location.

**Tables**

| Table | Purpose |
| --- | --- |
| `enquiries` | Enquiry widget and contact form submissions |
| `job_applications` | Career applications and resume metadata |
| `admin_users` | Admin accounts (bcrypt hashes only) |
| `schema_migrations` | Applied migrations |

Create the first administrator:

```bash
cd backend
npm run hash:password -- "YourStrongAdminPassword"   # prints ADMIN_PASSWORD_HASH=...
```

Put the hash in `backend/.env`, or store it in the database:

```bash
SEED_ADMIN_PASSWORD='YourStrongAdminPassword' npm run db:seed
```

`db:seed` also inserts two clearly-labelled sample enquiries outside production so the
admin screen has something to show.

---

## 6. Environment variables

Full reference with comments: [`.env.example`](.env.example).

### `frontend/.env.local` — compiled into the public bundle, never secret

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SITE_URL` | Canonical origin for canonical URLs, sitemap and OG tags |
| `NEXT_PUBLIC_API_BASE_URL` | API base including `/api` |
| `NEXT_PUBLIC_YOUTUBE_URL` | Official channel. Blank hides the link — no URL is invented |
| `NEXT_PUBLIC_GOOGLE_MAPS_EMBED_URL` | Maps embed `src`. Blank shows an accessible placeholder with directions |
| `NEXT_PUBLIC_RECAPTCHA_SITE_KEY` | reCAPTCHA v2 site key. Public by design. Blank disables the checkbox and shows submit buttons normally |
| `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` | Optional Search Console token |

### `backend/.env` — secret

| Variable | Notes |
| --- | --- |
| `NODE_ENV`, `PORT` | Runtime basics |
| `TRUST_PROXY` | **Set to `1` in production** so rate limiting sees the real client IP |
| `APP_URL` | Public website URL, used in email links |
| `CORS_ORIGINS` | Comma-separated allowlist of browser origins |
| `DATABASE_URL` *or* `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` | Connection |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` | Gmail App Password |
| `SMTP_FROM_NAME`, `SMTP_FROM_EMAIL` | Display sender. **Leave `SMTP_FROM_EMAIL` blank unless it is a verified alias on `SMTP_USER`** — see below |
| `ADMIN_EMAILS` | **The single source of truth for notification recipients.** Comma-separated; every address receives every enquiry and application. No address is hard-coded anywhere |
| `ADMIN_LOGIN_EMAIL`, `ADMIN_PASSWORD_HASH` | Fallback admin sign-in when `admin_users` is empty. A credential, not a recipient (`ADMIN_EMAIL` still accepted) |
| `JWT_SECRET` | Session signing key. **≥ 32 characters, or the API refuses to start in production** |
| `SESSION_TTL_HOURS`, `COOKIE_SAMESITE` | Session lifetime and cookie policy |
| `RECAPTCHA_SECRET_KEY` | reCAPTCHA v2 secret. **Server-side only.** Blank disables verification |
| `RECAPTCHA_MIN_SCORE`, `RECAPTCHA_FAIL_CLOSED` | v3 score threshold (unused by v2); whether a Google outage blocks submissions (default: no) |
| `UPLOAD_DIR`, `MAX_UPLOAD_MB` | Resume storage — keep it outside the web root |
| `RATE_LIMIT_*`, `FORM_RATE_LIMIT_MAX`, `LOGIN_RATE_LIMIT_MAX` | Throttling |
| `LOG_LEVEL` | `error` \| `warn` \| `info` \| `debug` |

Configuration is validated by Zod at startup, so a typo fails loudly at boot instead of
at the first enquiry.

---

## 7. Gmail SMTP setup

1. Sign in to the Google account for `info@jmkglobalholdings.com`.
2. **Security ▸ 2-Step Verification** — enable it (App passwords require it).
3. **Security ▸ App passwords** — create one named "JMK Website" and copy the
   16 characters.
4. Set it as `SMTP_PASSWORD` in `backend/.env` (no spaces) and restart the API.
5. The startup log prints `SMTP connection verified`, or a specific error.

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=the-gmail-account@gmail.com
SMTP_PASSWORD=your-16-character-app-password
SMTP_FROM_EMAIL=
ADMIN_EMAILS=info@jmkglobalholdings.com,hr@jmkglobalholdings.com
```

Port 465 requires `SMTP_SECURE=true` (implicit TLS); port 587 requires
`SMTP_SECURE=false` (STARTTLS). Mixing them makes Gmail hang until the socket times out,
which looks like "email does nothing". The API warns at startup if they disagree.

Never use the account password, and never put SMTP credentials in frontend code — they
only ever exist in `backend/.env`.

### The "sent successfully but nothing arrives" trap

If `SMTP_FROM_EMAIL` is on a different domain to `SMTP_USER` — say the mail claims to be
from `info@jmkglobalholdings.com` but is sent through a `@gmail.com` account — Gmail
still returns `250 OK`, so every log says the message was sent. The receiving server then
finds no SPF or DKIM authorisation for that domain, DMARC fails, and the mail is filed as
spam. **Leave `SMTP_FROM_EMAIL` blank** unless the address is a verified alias on the
sending account; `Reply-To` still points replies at the business inbox. The API logs a
warning at startup when the two domains disagree.

### Checking the pipeline

```bash
curl http://localhost:5000/api/diagnostics/mail          # config + transporter.verify()
curl -X POST http://localhost:5000/api/diagnostics/mail/test   # real message to ADMIN_EMAILS
```

Both routes are open in development and require an admin session in production. Neither
ever returns a credential — the report says whether a password is *present*, never what
it is. The response reports Gmail's own verdict (`accepted` / `rejected` counts), which
is the only thing that distinguishes a working setup from one that merely returns a
message id.

**What gets sent.** Each enquiry produces a notification to every address in
`ADMIN_EMAILS` (with `Reply-To` set to the sender) and a branded confirmation to the
person who wrote in, carrying their reference number. Career applications do the same,
with the resume attached to the admin notification. All four messages share one layout
(`backend/src/services/email/layout`), so the header and footer exist once.

The record is written before any email is attempted, so an SMTP outage can never lose an
enquiry or an application. The outcome is not hidden either: `notification_sent` /
`autoreply_sent` record it, and the API response carries an `emailStatus` so the
confirmation shown to the visitor says the message could not be sent instead of claiming
it was. Leave `SMTP_USER`/`SMTP_PASSWORD` empty in development and email is skipped
entirely.

---

## 8. Development commands

Run from the repository root:

| Command | What it does |
| --- | --- |
| `npm run dev` | Website (`:3000`) and API (`:5000`) together |
| `npm run dev:web` / `npm run dev:api` | One at a time |
| `npm run build` | Production build of both |
| `npm run typecheck` | TypeScript across both projects |
| `npm run lint` | ESLint on the frontend |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:seed` | Seed the admin user (+ dev sample data) |
| `npm run hash:password -- "password"` | Generate a bcrypt hash |
| `npm start` | Serve the **production build** locally — website (`:3000`) + API (`:5000`) |
| `npm run start:web` / `npm run start:api` | One at a time |

Frontend-only extras: `npm --prefix frontend run og:generate` regenerates the social card
(it also runs automatically before every build).

### Local demo of the real build

```bash
npm start                  # http://localhost:3000  (API on :5000)
```

`npm start` runs what a visitor gets, not the dev server: the static export in
`frontend/out/` served by a dependency-free file server, plus the compiled API from
`backend/dist/`. Anything missing is built first, so a fresh clone needs no separate build
step; an existing build is reused, so repeat runs start immediately. After changing source,
run `npm run build` before `npm start` — the export is pre-rendered and does not hot-reload.

The static server mirrors the production host: `/about/` resolves to `about/index.html`,
unknown paths return `404.html` with a real 404, and hashed `_next/static` assets are
cached while HTML is revalidated. Serve a different port with
`npm run start:web -- --port 4000`.

---

## 9. Production build

```bash
# Website  →  frontend/out/  (upload the contents to public_html)
cd frontend && npm run build

# API      →  backend/dist/  (run with node dist/server.js)
cd backend && npm run build
```

`frontend/out/` contains the pre-rendered HTML for all eleven public pages plus the admin
shell, `sitemap.xml`, `robots.txt`, the social card and the `.htaccess`.

Because pages are pre-rendered, **any content change requires a rebuild and re-upload**.

---

## GitHub setup

A remote is already configured — check before adding another:

```bash
git remote -v          # expect: origin  https://github.com/dev-jmkgh/landing-page.git
git status             # confirm no .env file is listed
git add .
git commit -m "Website update"
git push origin main
```

If `git remote -v` prints nothing, add your own remote first:

```bash
git remote add origin <YOUR_REPOSITORY_URL>
git branch -M main
git push -u origin main
```

`.gitignore` already excludes `.env`, `.env.*` (except the examples), `node_modules/`,
build output, `backend/storage/` and `.claude/settings.local.json`.

---

## 10a. GitHub Pages — UI demo (current)

The front end is deployed to GitHub Pages for design review. **No backend, database or
email is deployed there.** The enquiry and careers forms remain in the UI and say plainly
that submissions cannot be received yet — they never pretend to succeed.

**One-time setup**

1. Push to GitHub (see [GitHub setup](#github-setup) below).
2. Repository **Settings ▸ Pages ▸ Build and deployment ▸ Source** → **GitHub Actions**.
3. Push to `main`. [`.github/workflows/pages.yml`](.github/workflows/pages.yml) builds and
   publishes automatically.
4. The URL appears in the workflow summary: `https://<owner>.github.io/<repo>/`.

**How it is configured**

| Concern | Handling |
| --- | --- |
| Sub-path (`/<repo>/`) | `NEXT_PUBLIC_BASE_PATH`, set by the workflow from the repository name — nothing hard-coded |
| Routing | Static export writes real `route/index.html` files, so deep links and refreshes work without an SPA redirect hack |
| `_next/` assets | `public/.nojekyll` — without it Jekyll hides underscore folders and the site loads unstyled |
| Public asset paths | `assetPath()` in `src/lib/paths.ts`; `next/image` does not add the base path itself when `unoptimized` is set |
| API | `NEXT_PUBLIC_API_BASE_URL` is empty, so `isApiConfigured()` is false and the forms explain why |

**Nothing here is GitHub-specific.** Build with `NEXT_PUBLIC_BASE_PATH` empty and the same
output serves from a domain root — which is what S3/CloudFront will need.

> Building locally? `.env.local` overrides shell variables, so a local production build
> picks up your development API URL. That is fine for local checks; CI has no `.env.local`.

---

## 10b. Hostinger deployment

Full walkthrough: **[`docs/deployment-hostinger.md`](docs/deployment-hostinger.md)**.

The short version:

1. **Push to GitHub.** `.gitignore` already excludes `.env`, `node_modules/`, build
   output and `backend/storage/`.
2. **Database.** hPanel ▸ Databases ▸ create one; import the three SQL files from
   `backend/database/migrations/` through phpMyAdmin, or run `npm run db:migrate:prod` on the
   server.
3. **Website.** Build locally with the production `NEXT_PUBLIC_*` values, then upload
   the contents of `frontend/out/` into `public_html` — including the hidden `.htaccess`.
   Or let `.github/workflows/deploy.yml` do it on every push once the FTP secrets are set.
4. **API.** Create the `api.jmkglobalholdings.com` subdomain, upload `backend/dist/`,
   `backend/package.json`, `backend/package-lock.json` and `backend/database/` to a folder
   **outside** `public_html`, run `npm ci --omit=dev`, add `.env` (`chmod 600`), and start it with
   hPanel ▸ Advanced ▸ Node.js (startup file `dist/server.js`) or PM2 on a VPS.
5. **Storage.** `mkdir -p ~/api-storage/resumes && chmod 700 ~/api-storage/resumes`, and
   point `UPLOAD_DIR` at it. It must not be inside `public_html`.
6. **Verify.** `curl https://api.jmkglobalholdings.com/api/health`, then submit a test
   enquiry and confirm it reaches both the database and the inbox.

**Plan note.** The website runs on any Hostinger plan. The API needs Node.js, which
Hostinger provides on Cloud and VPS plans (look for hPanel ▸ Advanced ▸ Node.js). On a
shared plan you can publish the website immediately and add the API when you upgrade —
until then the forms will report that they cannot reach the server.

---

## 11. Domain and HTTPS

DNS in hPanel ▸ Domains ▸ DNS Zone:

| Type | Name | Value |
| --- | --- | --- |
| A | `@` | hosting IP |
| A / CNAME | `www` | hosting IP / `jmkglobalholdings.com` |
| A | `api` | API server IP |

Issue free Let's Encrypt certificates for all three hosts (hPanel ▸ Security ▸ SSL) and
enable **Force HTTPS**. The deployed `.htaccess` then guarantees a single canonical
address:

```
http://jmkglobalholdings.com   ┐
https://jmkglobalholdings.com  ├─▶  https://www.jmkglobalholdings.com
http://www.jmkglobalholdings.com ┘
```

Each page also declares `<link rel="canonical">` against the `www` HTTPS URL, and the
sitemap uses the same origin, so search engines see one address for one page.

---

## 12. Editing site content

| To change | Edit |
| --- | --- |
| Hero, welcome text, statistics, contribution cards, why-choose list | `frontend/src/lib/content/home.ts` |
| Who we are, vision, mission, values, founders | `frontend/src/lib/content/about.ts` |
| Verticals, services, group sectors, per-page SEO | `frontend/src/lib/content/business.ts` |
| Job roles and benefits | `frontend/src/lib/content/careers.ts` (mirror role changes in `backend/src/modules/applications/application.schema.ts`) |
| Gallery slots | `frontend/src/lib/content/gallery.ts` |
| Address, phones, email, social links, navigation | `frontend/src/lib/site.ts` |
| Colours, typography, spacing | `frontend/src/styles/tokens.css` |
| Images | Drop files into `frontend/public/images/…` — see [docs/image-assets.md](docs/image-assets.md) |

Rebuild and re-upload after any change. Update `docs/content-map.md` in the same commit
when a fact changes, so the record of what is verifiable stays accurate.

---

## 13. Security notes

- **Validation** happens on the server for every field; the browser copy exists only for
  fast feedback.
- **SQL injection** — all queries use bound parameters. The only values interpolated are
  `LIMIT`/`OFFSET` integers that Zod has already validated.
- **XSS** — React escapes page content, and user text placed into HTML emails is escaped
  explicitly.
- **Spam** — reCAPTCHA v2 (the submit button only appears once the checkbox is solved,
  and the token is verified server-side with Google), plus a honeypot field, a minimum
  fill time, per-IP rate limits and per-IP database ceilings. Every one of those still
  applies if reCAPTCHA is disabled or fails to load.
- **Uploads** — extension allowlist, MIME allowlist, size cap, generated filename,
  magic-byte verification after write, and storage outside the web root. Rejected
  uploads are deleted.
- **Admin auth** — bcrypt hashes only; no password anywhere in source. Session in an
  HttpOnly cookie, CSRF token bound to the session, timing-equalised login, rate-limited
  sign-in, and `/admin/` excluded in `robots.txt` and by `noindex`.
- **Errors** — clients get a stable JSON shape; stack traces and SQL stay in the log.
- **Headers** — Helmet on the API, and CSP/HSTS/nosniff/frame-options via `.htaccess` on
  the website.

If you find a security issue, email `info@jmkglobalholdings.com` rather than opening a
public issue.

---

## 14. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Invalid environment configuration` at startup | The message names the variable — check `backend/.env` against `.env.example` |
| `JWT_SECRET must be set to at least 32 characters` | Generate one: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `Database connection failed` | Verify `DB_*`; on Hostinger the user and database names carry a `u123456789_` prefix |
| Forms report they cannot reach the server | Check `NEXT_PUBLIC_API_BASE_URL`, then `curl <api>/api/health` |
| CORS error in the console | Add the exact origin to `CORS_ORIGINS` and restart the API |
| Enquiry saves, no email | Look for `SMTP verification failed` in the log; regenerate the Gmail App Password |
| Resume upload fails around 1 MB | Raise Nginx `client_max_body_size` to `6M` |
| Admin signs in then straight back out | Cookie blocked — both hosts must be HTTPS; across different domains set `COOKIE_SAMESITE=none` |
| 404s on every page after upload | The hidden `.htaccess` was not uploaded |
| Unstyled pages | The `_next/` folder was not uploaded |
| `next build` fails on fonts | The build fetches Google Fonts once; it needs network access |

---

© JMK Global Holdings. All rights reserved.
