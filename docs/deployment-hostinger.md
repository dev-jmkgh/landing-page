# Deploying to Hostinger from GitHub

> **The short version.** The website is a static export, so it drops straight into
> `public_html`. The API is a small Node.js service that runs on a subdomain. You push
> to GitHub; Hostinger pulls the frontend automatically, and the API is updated with one
> SSH command (or the same Git hook if your plan runs Node).

---

## 0. What you need before you start

| Item | Where it comes from |
| --- | --- |
| Hostinger account with an active hosting plan | hostinger.com |
| `jmkglobalholdings.com` domain | Registered at Hostinger, or pointed to Hostinger nameservers |
| A GitHub repository containing this project | See [GitHub setup](#1-push-the-project-to-github) |
| Gmail App Password for `info@jmkglobalholdings.com` | See [Gmail SMTP setup](#6-gmail-smtp-setup) |
| Node.js 18.18+ on your own machine | For building the frontend |

**Which Hostinger plan do I need?**

- The **website alone** works on every plan — it is static HTML, CSS and JavaScript.
- The **API** (enquiry forms, career applications, admin area) needs Node.js and MySQL.
  Hostinger runs Node.js applications on **Cloud hosting and VPS plans**; shared
  Premium/Business plans give you MySQL and PHP but not a long-running Node process.
  If you are on a shared plan today, deploy the website now and either upgrade to Cloud
  or add the cheapest VPS for `api.jmkglobalholdings.com` when you want the forms live.
  Check *hPanel ▸ Advanced ▸ Node.js* — if that section exists, your plan supports it.

---

## 1. Push the project to GitHub

```bash
cd landing-page
git init                       # skip if the repo already exists
git add .
git commit -m "JMK Global Holdings website"
git branch -M main
git remote add origin https://github.com/dev-jmkgh/landing-page.git
git push -u origin main
```

Confirm before pushing that `git status` does **not** list `.env`, `node_modules/`,
`frontend/out/`, `backend/dist/` or `backend/storage/`. The `.gitignore` in the project
root already excludes all of them.

---

## 2. Create the database

1. hPanel ▸ **Databases ▸ Management**.
2. Create a database, e.g. `u123456789_jmk`, with a user and a strong generated password.
3. Note the four values — database name, user, password, and host (usually `localhost`).
4. Keep **Remote MySQL** switched off unless you specifically need it.

Create the tables. Either import the SQL files through phpMyAdmin, in order:

```
backend/database/migrations/001_create_enquiries.sql
backend/database/migrations/002_create_job_applications.sql
backend/database/migrations/003_create_admin_users.sql
```

…or, once the API is on the server with its `.env` in place, run the migration runner:

```bash
cd ~/api
npm run db:migrate:prod
```

---

## 3. Build and upload the website

On your own machine:

```bash
cd frontend
cp .env.example .env.local
```

Edit `.env.local`:

```env
NEXT_PUBLIC_SITE_URL=https://www.jmkglobalholdings.com
NEXT_PUBLIC_API_BASE_URL=https://api.jmkglobalholdings.com/api
```

Then:

```bash
npm install
npm run build          # produces frontend/out/
```

Upload **the contents of `frontend/out/`** (not the folder itself) into `public_html`.
Use hPanel ▸ **File Manager**, or FTP, or the GitHub Action in
[section 8](#8-automating-deployment-from-github).

The export already contains a tuned `.htaccess` — it forces HTTPS and the `www` host,
serves clean URLs, sets cache headers and adds security headers. Make sure hidden files
are visible in File Manager so it is uploaded too.

> **Rebuild whenever content changes.** The site is pre-rendered, so editing a file in
> `src/lib/content/` requires `npm run build` and a re-upload of `frontend/out/`.

---

## 4. Deploy the API

### 4a. Create the subdomain

hPanel ▸ **Domains ▸ Subdomains** ▸ create `api` → `api.jmkglobalholdings.com`.
Then hPanel ▸ **Security ▸ SSL** and issue a free certificate for it.

### 4b. Upload the API

Only these need to reach the server:

```
backend/dist/          (built output)
backend/package.json
backend/package-lock.json
backend/database/       (the schema travels with the backend)
```

Build locally first:

```bash
cd backend
npm install
npm run build
```

Upload to a directory **outside** `public_html`, for example `~/api`. Then over SSH:

```bash
cd ~/api
npm ci --omit=dev
```

### 4c. Configure the environment

Create `~/api/.env` (use `backend/.env.example` as the template):

```env
NODE_ENV=production
PORT=5000
TRUST_PROXY=1

APP_URL=https://www.jmkglobalholdings.com
CORS_ORIGINS=https://www.jmkglobalholdings.com,https://jmkglobalholdings.com

DB_HOST=localhost
DB_PORT=3306
DB_USER=u123456789_jmk
DB_PASSWORD=your-database-password
DB_NAME=u123456789_jmk

SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=info@jmkglobalholdings.com
SMTP_PASSWORD=your-16-character-gmail-app-password
CONTACT_EMAIL=info@jmkglobalholdings.com

ADMIN_EMAIL=admin@jmkglobalholdings.com
ADMIN_PASSWORD_HASH=paste-the-bcrypt-hash-here
JWT_SECRET=paste-a-64-character-random-string-here

RECAPTCHA_SECRET_KEY=paste-the-recaptcha-v2-secret-here

UPLOAD_DIR=/home/u123456789/api-storage/resumes
```

Set the file permissions so only your account can read it:

```bash
chmod 600 ~/api/.env
```

Generate the two secrets:

```bash
# On your own machine, inside backend/
npm run hash:password -- "YourStrongAdminPassword"
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 4d. Start it

**If your plan has hPanel ▸ Advanced ▸ Node.js:**

| Field | Value |
| --- | --- |
| Application root | `api` |
| Application URL | `api.jmkglobalholdings.com` |
| Application startup file | `dist/server.js` |
| Node version | 18 or newer |

Click **Create**, then **Restart** after any change to `.env`.

**On a VPS, use PM2 so it survives reboots:**

```bash
npm install -g pm2
cd ~/api
pm2 start dist/server.js --name jmk-api
pm2 save
pm2 startup          # run the command it prints
```

### 4e. Point the subdomain at the Node process

On a VPS, put Nginx in front of it:

```nginx
server {
    listen 80;
    server_name api.jmkglobalholdings.com;

    location / {
        proxy_pass         http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        client_max_body_size 6M;     # room for a 5 MB resume
    }
}
```

Then issue the certificate:

```bash
sudo certbot --nginx -d api.jmkglobalholdings.com
```

`client_max_body_size` matters — leave it at the Nginx default of 1 MB and resume
uploads fail at the proxy before they ever reach the API.

### 4f. Confirm it works

```bash
curl https://api.jmkglobalholdings.com/api/health
# {"status":"ok","service":"jmk-api","environment":"production",...}
```

---

## 5. Create the storage directory for resumes

```bash
mkdir -p ~/api-storage/resumes
chmod 700 ~/api-storage/resumes
```

It **must** sit outside `public_html`. Resumes are personal data; they are served only
through the authenticated admin download route, never as static files.

---

## 6. Gmail SMTP setup

1. Sign in to the Google account for `info@jmkglobalholdings.com`.
2. **Google Account ▸ Security ▸ 2-Step Verification** — turn it on. App passwords do
   not exist without it.
3. **Google Account ▸ Security ▸ App passwords** — create one, name it
   "JMK Website", and copy the 16-character password.
4. Put it in `SMTP_PASSWORD` in `~/api/.env`. Remove the spaces Google displays.
5. Restart the API. The startup log prints `SMTP connection verified` on success, or a
   clear error if the credentials are wrong.

Notes:

- Use the App Password, never the account password.
- Gmail rewrites the `From` address to the authenticated account unless the address is
  a verified alias, so keep `SMTP_FROM_EMAIL` equal to `SMTP_USER` unless you have set
  one up.
- Free Gmail sends roughly 500 messages a day. Google Workspace allows about 2,000. If
  volume grows past that, switch to a transactional provider — only `SMTP_*` changes.

---

## 7. Domain and DNS

In hPanel ▸ **Domains ▸ DNS Zone** for `jmkglobalholdings.com`:

| Type | Name | Value | Purpose |
| --- | --- | --- | --- |
| A | `@` | your hosting IP | Root domain |
| A (or CNAME) | `www` | your hosting IP (or `jmkglobalholdings.com`) | Canonical website |
| A | `api` | your API server IP | The API subdomain |

If the domain is registered elsewhere, point its nameservers at
`ns1.dns-parking.com` and `ns2.dns-parking.com` (hPanel shows the exact pair for your
account). DNS changes take up to 24 hours to propagate.

### HTTPS

hPanel ▸ **Security ▸ SSL** ▸ install the free Let's Encrypt certificate for
`jmkglobalholdings.com`, `www.jmkglobalholdings.com` and `api.jmkglobalholdings.com`.
Enable **Force HTTPS**.

### Canonical host

The `.htaccess` in `public_html` already sends everything to
`https://www.jmkglobalholdings.com`:

```
http://jmkglobalholdings.com       →  https://www.jmkglobalholdings.com
https://jmkglobalholdings.com      →  https://www.jmkglobalholdings.com
http://www.jmkglobalholdings.com   →  https://www.jmkglobalholdings.com
```

Every page also emits a `<link rel="canonical">` pointing at the `www` HTTPS URL, so
there is no duplicate-content ambiguity for search engines.

---

## 8. Automating deployment from GitHub

### Option A — Hostinger's Git integration (simplest)

1. hPanel ▸ **Advanced ▸ GIT**.
2. Repository: your GitHub URL. Branch: `main`. Install path: `public_html`.
3. Because Hostinger only pulls files and does not run `npm run build`, commit the
   built site: run `npm run build` in `frontend/`, then commit `frontend/out/` and set
   the install path to that folder. (Remove `frontend/out/` from `.gitignore` first if
   you choose this route.)
4. Copy the **webhook URL** shown in hPanel into GitHub ▸ Settings ▸ Webhooks so each
   push deploys automatically.

### Option B — GitHub Actions (recommended)

`.github/workflows/deploy.yml` in this repository builds the site on GitHub's runners
and uploads `frontend/out/` over FTPS, so no build output is committed.

Add these repository secrets under **Settings ▸ Secrets and variables ▸ Actions**:

| Secret | Value |
| --- | --- |
| `FTP_SERVER` | e.g. `ftp.jmkglobalholdings.com` (hPanel ▸ Files ▸ FTP Accounts) |
| `FTP_USERNAME` | Your FTP user |
| `FTP_PASSWORD` | Your FTP password |
| `SITE_URL` | `https://www.jmkglobalholdings.com` |
| `API_BASE_URL` | `https://api.jmkglobalholdings.com/api` |

Push to `main` and the workflow builds and publishes. The API is deployed separately —
see the commented SSH job at the bottom of that workflow file.

---

## 9. Post-deployment checklist

```
[ ] https://www.jmkglobalholdings.com loads over HTTPS
[ ] jmkglobalholdings.com and http:// both redirect to https://www.
[ ] Every nav link works: Home, About, Business (+3 verticals), Gallery, Careers, Contact
[ ] The floating "Enquire Now" button opens the modal on desktop and mobile
[ ] Submitting an enquiry shows the success message
[ ] The enquiry appears in the database (phpMyAdmin ▸ enquiries)
[ ] info@jmkglobalholdings.com receives the notification email
[ ] The sender receives the auto-reply
[ ] A career application with a PDF resume submits successfully
[ ] The resume file lands in the storage directory, not in public_html
[ ] /admin/enquiries shows the login form and rejects a wrong password
[ ] Signing in lists the enquiries and status changes persist
[ ] https://www.jmkglobalholdings.com/sitemap.xml and /robots.txt load
[ ] Google Search Console: property verified, sitemap submitted
```

The full test matrix is in [`testing-checklist.md`](./testing-checklist.md).

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Forms show "We could not reach our servers" | `NEXT_PUBLIC_API_BASE_URL` wrong, or the API is down | `curl https://api.jmkglobalholdings.com/api/health`, then rebuild the frontend with the correct URL |
| Browser console shows a CORS error | The site origin is missing from `CORS_ORIGINS` | Add both `https://www.…` and `https://…` to `CORS_ORIGINS`, restart the API |
| Enquiry saves but no email arrives | SMTP credentials, or Gmail blocked the sign-in | Check the API log for `SMTP verification failed`; regenerate the App Password |
| API log: `Database connection failed` | Wrong DB credentials, or the DB user lacks access | Re-check `DB_*` in `.env`; Hostinger DB users are prefixed (`u123456789_`) |
| Resume upload fails at ~1 MB | Nginx `client_max_body_size` | Raise it to `6M` and reload Nginx |
| Admin sign-in always fails | `ADMIN_PASSWORD_HASH` missing or truncated | Regenerate with `npm run hash:password`; the hash starts with `$2a$` or `$2b$` |
| Admin logs in, then is signed out immediately | Cookie rejected across sites | Both hosts must be HTTPS. If the site and API are on different domains, set `COOKIE_SAMESITE=none` |
| Pages 404 after upload | `.htaccess` missing (hidden file not uploaded) | Enable hidden files in File Manager and upload it |
| Styles missing | `_next/` folder not uploaded | Re-upload the whole contents of `frontend/out/` |
| API stops after a while | Process not managed | Use hPanel's Node.js app manager or PM2 with `pm2 save` |
| Startup error about `JWT_SECRET` | Secret shorter than 32 characters in production | Generate a proper one; this check is deliberate |
