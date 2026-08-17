# Production deployment — AWS Mumbai (ap-south-1)

Target architecture:

```
jmkglobalholdings.com        -> Nginx -> frontend/out          (static export)
www.jmkglobalholdings.com    -> same
api.jmkglobalholdings.com    -> Nginx -> 127.0.0.1:5000        (Node API, systemd)
                                          |
                                          +-- MySQL
                                          +-- Gmail SMTP
                                          +-- storage/resumes   (local disk)
```

Region **ap-south-1 (Mumbai)** — nearest AWS region to Coimbatore, so both the
database round trip and the visitor's latency stay in-country.

---

## 0. What this application does *not* need

The backend calls **no AWS service**. There is no `aws-sdk` or `@aws-sdk/*`
dependency; resumes are written to local disk by multer, and mail goes out through
Gmail SMTP with nodemailer.

So the EC2 instance needs **no IAM role and no AWS access keys** for the application
to run. AWS is only the Linux box and the DNS. Nothing in the app authenticates to
AWS, which means there is no AWS credential on the server to leak.

If resumes later move to S3, that is the moment to attach a role — scoped to
`s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on the one bucket prefix, and
nothing else.

**Never put `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in `backend/.env`.** They are
not read by anything, and their only possible effect is to become a leaked secret.

---

## 1. Facts taken from the repository

Do not substitute conventions from other projects; these are what this one uses.

| | |
| --- | --- |
| Frontend | Next.js 15 App Router, `output: 'export'`, `trailingSlash: true` |
| Frontend build | `npm --prefix frontend run build` → **`frontend/out/`** |
| Backend | Express 4 + TypeScript, compiled with `tsc` |
| Backend build | `npm --prefix backend run build` → **`backend/dist/`** |
| Backend entry | **`backend/dist/server.js`** (`package.json` `main`) |
| Backend port | **5000** (`PORT`, default 5000) |
| Health endpoint | **`GET /api/health`** — already exists, returns `{"status":"ok"}` |
| Migrations | `npm --prefix backend run db:migrate:prod` — forward-only, checksummed, no reset path |
| Database | MySQL via `mysql2` |
| Package manager | npm (`package-lock.json` committed) |
| Node | **>= 18.18** — use Node 20 LTS |
| Uploads | local disk, `UPLOAD_DIR`, kept outside the web root |

**The frontend is not a Vite SPA.** Environment variables are `NEXT_PUBLIC_*`, not
`VITE_*`, and the Nginx config must not use an SPA `/index.html` fallback — see the
comment in `deploy/nginx/jmkglobalholdings.com.conf`.

---

## 2. Instance and network

1. **EC2** — Ubuntu 24.04 LTS, `t3.small` or larger, in `ap-south-1`.
   `t3.micro` will build the frontend very slowly and can run out of memory during
   `next build`; if you must use one, add swap first.
2. **Elastic IP** — allocate and associate. DNS points at this, so replacing the
   instance later does not mean re-pointing Route 53 and waiting on TTLs.
3. **Security group**
   - 22/tcp — **your IP only**, not `0.0.0.0/0`
   - 80/tcp, 443/tcp — anywhere
   - **5000 — not open.** Nginx reaches it over loopback.
4. **MySQL** — if RDS, put it in the same region and VPC, and allow 3306 *from the
   EC2 security group only*, never from the internet.

---

## 3. Server preparation

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx git curl mysql-client

# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v            # expect v20.x

sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/local/bin/certbot

# A dedicated unprivileged user — the API must not run as root.
sudo adduser --system --group --home /var/www/jmkglobalholdings jmk
sudo mkdir -p /var/www/jmkglobalholdings /var/www/jmkglobalholdings/storage/resumes
sudo chown -R jmk:jmk /var/www/jmkglobalholdings
```

`storage/` sits beside the checkout rather than inside it, so a deploy can never
delete an uploaded resume.

---

## 3a. MySQL on the same instance

The database runs on this box, reachable only over loopback. Nothing in the
security group opens 3306, and nothing should: the API is the only client and it
connects to `127.0.0.1`.

```bash
sudo apt install -y mysql-server
sudo systemctl enable --now mysql
systemctl status mysql
```

### Confirm it is not listening on a public interface

Ubuntu's package defaults to `bind-address = 127.0.0.1`. Verify rather than assume —
a MySQL open to the internet is found by scanners within hours:

```bash
ss -lntp | grep 3306          # expect 127.0.0.1:3306, never 0.0.0.0:3306
```

If it shows `0.0.0.0`, set `bind-address = 127.0.0.1` in
`/etc/mysql/mysql.conf.d/mysqld.cnf` and `sudo systemctl restart mysql`.

### Harden

```bash
sudo mysql_secure_installation
```

Answer: yes to removing anonymous users, yes to disallowing remote root, yes to
dropping the test database, yes to reloading privileges. The validate-password
plugin is optional — the application user's password is generated below and will
pass any policy.

### Create the database and the application user

The schema is `utf8mb4` / `utf8mb4_unicode_ci` — the migrations declare it per table,
and the database default should match so anything added later inherits it. This
matters for real content: rupee signs, em-dashes and names outside Latin-1 all need
four-byte UTF-8.

Generate a password first and keep it in your password manager — it goes into
`backend/.env` and nowhere else:

```bash
openssl rand -base64 24
```

Then, as root:

```bash
sudo mysql
```

```sql
CREATE DATABASE jmk_global
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

-- 'localhost' deliberately: this account cannot be used from another host even if
-- the port were ever exposed.
CREATE USER 'jmk_app'@'localhost' IDENTIFIED BY 'PASTE_THE_GENERATED_PASSWORD';

-- Only what the application does. No DROP, no GRANT OPTION, and no access to any
-- other schema. The migration runner needs CREATE, ALTER and INDEX; it never drops
-- a table, and this account could not do so if a migration tried.
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
  ON jmk_global.* TO 'jmk_app'@'localhost';

FLUSH PRIVILEGES;
EXIT;
```

Check the account works before pointing the application at it:

```bash
mysql -u jmk_app -p -e "SELECT 1;" jmk_global
```

### Matching `backend/.env`

```
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=jmk_app
DB_PASSWORD=<the generated password>
DB_NAME=jmk_global
DB_CONNECTION_LIMIT=10
```

Use `127.0.0.1` rather than `localhost`: with `localhost`, the MySQL client library
may prefer a Unix socket, and the socket path differs between distributions. An
explicit address takes TCP every time.

Leave `DATABASE_URL` unset — the configuration prefers it when present, and having
both invites the two of them to drift apart.

### Migrations

```bash
cd /var/www/jmkglobalholdings
sudo -u jmk npm --prefix backend run db:migrate:prod
```

Forward-only, and each file's checksum is recorded: an applied migration that is later
edited is reported rather than silently re-run. There is no reset command in this
runner, by design.

Confirm the four tables exist:

```bash
mysql -u jmk_app -p -e "SHOW TABLES;" jmk_global
# enquiries, job_applications, admin_users, schema_migrations
```

### Seed the admin account

```bash
npm --prefix backend run hash:password -- 'a-strong-password'
```

Put the hash in `ADMIN_PASSWORD_HASH` and the address in `ADMIN_LOGIN_EMAIL`, then:

```bash
sudo -u jmk npm --prefix backend run db:seed
```

`ADMIN_LOGIN_EMAIL` is the sign-in identity. It is *not* where notifications go —
that is `ADMIN_EMAILS`, and the two are independent.

### Backups

Nothing here is backed up yet. Enquiries and job applications are the only
irreplaceable data on this instance, and resumes on local disk are not covered by an
RDS snapshot because there is no RDS.

```bash
sudo mkdir -p /var/backups/jmk && sudo chown jmk:jmk /var/backups/jmk
```

`sudo -u jmk crontab -e`:

```
15 2 * * * mysqldump --single-transaction --quick -u jmk_app -p'PASSWORD' jmk_global | gzip > /var/backups/jmk/jmk_global-$(date +\%F).sql.gz && find /var/backups/jmk -name '*.sql.gz' -mtime +14 -delete
30 2 * * * tar czf /var/backups/jmk/resumes-$(date +\%F).tar.gz -C /var/www/jmkglobalholdings/storage resumes && find /var/backups/jmk -name 'resumes-*.tar.gz' -mtime +14 -delete
```

A password on a cron line is visible to anyone who can read that crontab. Better is a
`~/.my.cnf` with mode `600` holding the credentials, and no `-p` on the command. Copy
the archives off the instance periodically — a backup that only exists on the machine
it protects is not a backup.

---

## 4. Clone

```bash
sudo -u jmk git clone https://github.com/dev-jmkgh/landing-page.git /var/www/jmkglobalholdings
cd /var/www/jmkglobalholdings
sudo -u jmk git checkout main
```

For a private repository use a **read-only deploy key** on this server, not a personal
access token in a URL — a token in the remote URL ends up in `.git/config` in plain
text and grants far more than this box needs.

---

## 5. Secrets — created on the server only, never committed

### `backend/.env`

Copy `backend/.env.example` and fill it in. Variable **names** (values stay on the
server):

```
NODE_ENV, PORT, TRUST_PROXY,
APP_URL, CORS_ORIGINS,
DATABASE_URL  (or DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_CONNECTION_LIMIT),
SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD,
SMTP_FROM_NAME, SMTP_FROM_EMAIL,
ADMIN_EMAILS,
ADMIN_LOGIN_EMAIL, ADMIN_PASSWORD_HASH, JWT_SECRET, SESSION_TTL_HOURS, COOKIE_SAMESITE,
RECAPTCHA_SECRET_KEY, RECAPTCHA_MIN_SCORE, RECAPTCHA_FAIL_CLOSED,
UPLOAD_DIR, MAX_UPLOAD_MB,
RATE_LIMIT_WINDOW_MINUTES, RATE_LIMIT_MAX_REQUESTS, FORM_RATE_LIMIT_MAX, LOGIN_RATE_LIMIT_MAX,
LOG_LEVEL
```

Production values that differ from development:

```
NODE_ENV=production
TRUST_PROXY=1                     # required, or rate limiting sees only 127.0.0.1
APP_URL=https://jmkglobalholdings.com
CORS_ORIGINS=https://jmkglobalholdings.com,https://www.jmkglobalholdings.com
UPLOAD_DIR=/var/www/jmkglobalholdings/storage/resumes
JWT_SECRET=<64 hex chars>         # the API refuses to start in production if under 32
```

`JWT_SECRET`: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

**`SMTP_FROM_EMAIL` must be blank, or an address verified on the `SMTP_USER` account.**
Sending as `info@jmkglobalholdings.com` through an unrelated Gmail account is accepted
by Gmail and then fails SPF/DKIM alignment at the recipient, so DMARC files it as spam
— mail that "sends successfully" and is never seen. The API logs a warning at startup
when the two domains disagree. Replies still reach the business inbox via `Reply-To`.

Lock it down:

```bash
sudo chown jmk:jmk backend/.env && sudo chmod 600 backend/.env
```

### `frontend/.env.production`

Baked into the bundle at build time, so it must exist **before** the build:

```
NEXT_PUBLIC_SITE_URL=https://jmkglobalholdings.com
NEXT_PUBLIC_API_BASE_URL=https://api.jmkglobalholdings.com/api
NEXT_PUBLIC_BASE_PATH=
NEXT_PUBLIC_RECAPTCHA_SITE_KEY=<the v2 site key — public by design>
```

Note the `/api` suffix on the API URL: the client appends paths such as
`/careers/apply` directly.

---

## 6. Build, service, proxy

```bash
cd /var/www/jmkglobalholdings
sudo -u jmk npm --prefix backend ci && sudo -u jmk npm --prefix backend run build
sudo -u jmk npm --prefix backend run db:migrate:prod
sudo -u jmk npm --prefix frontend ci && sudo -u jmk npm --prefix frontend run build

sudo cp deploy/systemd/jmk-global-backend.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now jmk-global-backend
systemctl status jmk-global-backend
curl -s localhost:5000/api/health

sudo cp deploy/nginx/*.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/jmkglobalholdings.com.conf /etc/nginx/sites-enabled/
sudo ln -s /etc/nginx/sites-available/api.jmkglobalholdings.com.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

---

## 7. DNS — Route 53

**State as verified on 11 Aug 2026**, resolving against 8.8.8.8 rather than reading
the console — what the zone contains and what the internet answers are not always the
same thing:

| Name | Type | Value | Status |
| --- | --- | --- | --- |
| `jmkglobalholdings.com` | NS | four `awsdns` nameservers | delegated correctly |
| `jmkglobalholdings.com` | SOA | — | present |
| `api.jmkglobalholdings.com` | A | `3.110.84.46` | **resolves** |
| `jmkglobalholdings.com` | A | — | **missing** |
| `www.jmkglobalholdings.com` | — | — | **missing (NXDOMAIN)** |

The registrar delegates to Route 53 correctly and the API record already exists, so
nothing needs creating for the API. The apex and `www` have no address record at all,
so the website cannot be reached at either name until they are added.

Add two records — leave the NS and SOA alone:

| Name | Type | Value | TTL |
| --- | --- | --- | --- |
| `jmkglobalholdings.com` | A | `3.110.84.46` | 300 |
| `www.jmkglobalholdings.com` | A | `3.110.84.46` | 300 |

An EC2 instance is not an ALIAS target, so these are plain A records pointing at the
Elastic IP.

**Confirm `3.110.84.46` is an Elastic IP and not the instance's ephemeral public
address.** An ephemeral address changes the next time the instance is stopped and
started, and these records would then point at somebody else's machine.

```bash
aws ec2 describe-addresses --region ap-south-1 --public-ips 3.110.84.46
```

If that returns nothing, the address is ephemeral: allocate an Elastic IP, associate
it, and update both records to the new address.

Verify before continuing — DNS is not done until it resolves:

```bash
dig +short jmkglobalholdings.com
dig +short www.jmkglobalholdings.com
dig +short api.jmkglobalholdings.com
```

---

## 8. HTTPS

Only after DNS resolves to this instance:

```bash
sudo certbot --nginx -d jmkglobalholdings.com -d www.jmkglobalholdings.com
sudo certbot --nginx -d api.jmkglobalholdings.com
sudo certbot renew --dry-run
```

Certbot adds the 443 blocks and the HTTP→HTTPS redirect to the supplied configs.

---

## 9. Verification — none of this is optional

A running process is not a working deployment.

```bash
# Transport and DNS
dig +short jmkglobalholdings.com www.jmkglobalholdings.com api.jmkglobalholdings.com
curl -sI https://jmkglobalholdings.com | head -1
curl -sI http://jmkglobalholdings.com | head -2          # expect 301 to https
curl -s  https://api.jmkglobalholdings.com/api/health

# Mail: reports host, port, whether a password is present, and the recipient count.
# Never prints a credential. Requires an admin session in production.
curl -s https://api.jmkglobalholdings.com/api/diagnostics/mail
curl -s -X POST https://api.jmkglobalholdings.com/api/diagnostics/mail/test
```

Then, in a browser on `https://jmkglobalholdings.com`:

- an enquiry submits, reCAPTCHA challenges, the row appears in `enquiries`
- every address in `ADMIN_EMAILS` receives the notification; the visitor receives the confirmation
- a careers application submits with a PDF, the row appears in `job_applications`, and the resume is attached to the admin mail
- Enquire Now and Back-to-top work; the console is clean

Rejecting a bad reCAPTCHA and accepting a good one both matter — check
`journalctl -u jmk-global-backend | grep -i recaptcha`.

---

## 10. Subsequent deploys

```bash
cd /var/www/jmkglobalholdings && ./deploy/deploy.sh
```

Pulls, rebuilds both sides, migrates, restarts, reloads Nginx and waits for the health
check before reporting success. It refuses to run if the secrets are missing, and it
never writes to `backend/.env` or `frontend/.env.production`.

---

## 11. Logs

```bash
journalctl -u jmk-global-backend -f
sudo tail -f /var/log/nginx/error.log
```

Mail lines carry the type, recipient count, accepted/rejected counts, message id and
the SMTP response — enough to diagnose a delivery problem, and no credential. The
config report states whether a password is *present*, never its value.
