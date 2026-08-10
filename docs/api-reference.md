# API reference

Base URL: `https://api.jmkglobalholdings.com/api` (development: `http://localhost:5000/api`)

All requests and responses are JSON, except the career application endpoint
(`multipart/form-data`) and the resume download (a file stream).

## Response shapes

Success varies per endpoint. Errors are always:

```json
{
  "success": false,
  "code": "validation_failed",
  "message": "Please correct the highlighted fields and try again.",
  "errors": { "email": "Please enter a valid email address." }
}
```

`errors` is present only for validation failures and is keyed by form field name, which
is what the front-end forms use to highlight individual inputs.

| Status | `code` | Meaning |
| --- | --- | --- |
| 400 | `bad_request` | Rejected by an anti-spam or business rule |
| 401 | `unauthorized` | Missing, expired or invalid admin session |
| 403 | `forbidden` | CSRF token missing/incorrect, or origin not allowed |
| 404 | `not_found` | Unknown endpoint or record |
| 413 | `payload_too_large` | Request body above the limit |
| 422 | `validation_failed` | One or more fields failed validation |
| 429 | `rate_limited` | Rate limit exceeded |
| 500 | `server_error` | Unexpected failure (details are logged, never returned) |

---

## Public endpoints

### `GET /health`

Liveness check. Returns `{ "status": "ok", "service": "jmk-api", "environment": "production", "timestamp": "…" }`.

### `POST /enquiries`

Used by the floating enquiry widget, the contact page and the business-page CTAs.

```json
{
  "name": "Priya Raman",
  "email": "priya@example.com",
  "phone": "+91 90000 00000",
  "company": "Example Engineering",
  "interestedIn": "JMK Design Studio",
  "message": "We need 3D modelling support for a new product line.",
  "source": "contact-page",
  "website": "",
  "renderedAt": 1754800000000
}
```

| Field | Rules |
| --- | --- |
| `name` | required, 2–120 characters |
| `email` | required, valid address, ≤ 190 characters |
| `phone` | required, 7–15 digits, `+ ( ) -` and spaces allowed |
| `company` | optional, ≤ 150 characters |
| `interestedIn` | required, one of: JMK Academy, JMK Design Studio, JMK Software Solutions, Export Business, Agriculture, Renewable Energy, Other |
| `message` | required, 10–2000 characters |
| `source` | `floating-widget` \| `contact-page` \| `business-page` |
| `website` | honeypot — must be empty |
| `renderedAt` | epoch ms when the form was rendered; submissions faster than 2.5 s or older than 12 h are rejected |

**201**

```json
{
  "success": true,
  "message": "Thank you! Your enquiry has been submitted successfully. Our team will get back to you shortly.",
  "reference": "ENQ-7KQ4M2XP"
}
```

The response is returned as soon as the enquiry is stored. The internal notification and
the applicant auto-reply are sent afterwards, so an SMTP outage never costs an enquiry —
the `notification_sent` and `autoreply_sent` columns record what actually went out.

### `POST /applications`

`multipart/form-data`. Fields: `fullName`, `email`, `phone`, `position`, `message`
(optional), `website` (honeypot), `renderedAt`, and `resume` (the file).

`position` must be one of the 13 published roles. `resume` must be `.pdf`, `.doc` or
`.docx`, at most 5 MB, and its **contents** must match its extension — a `.pdf` that
does not begin with `%PDF` is rejected and deleted.

**201** → same shape as above with an `APP-` reference.

---

## Admin endpoints

All require a valid session cookie. Every state-changing request additionally requires
the `X-CSRF-Token` header, whose value is the `jmk_csrf` cookie set at sign-in.

### `POST /admin/auth/login`

`{ "email": "...", "password": "..." }` → **200** `{ "success": true, "email": "..." }`
and two cookies: `jmk_session` (HttpOnly) and `jmk_csrf` (readable).

A wrong email and a wrong password produce the same 401 and take the same amount of
time, so accounts cannot be enumerated.

### `POST /admin/auth/logout`

Requires CSRF. Clears both cookies.

### `GET /admin/auth/session`

**200** `{ "success": true, "email": "..." }` when signed in, **401** otherwise.

### `GET /admin/enquiries`

Query: `status` (`new` \| `contacted` \| `in_progress` \| `closed`), `q` (searches name,
email, phone, reference, company), `page` (default 1), `pageSize` (default 20, max 100).

```json
{
  "items": [ { "id": 1, "reference": "ENQ-…", "name": "…", "status": "new", "createdAt": "…" } ],
  "page": 1, "pageSize": 20, "total": 42, "totalPages": 3
}
```

### `PATCH /admin/enquiries/:id/status`

Requires CSRF. `{ "status": "contacted" }` → the updated record.

### `GET /admin/applications` · `PATCH /admin/applications/:id/status`

Identical to the enquiry equivalents; search covers name, email, phone, reference and position.

### `GET /admin/applications/:id/resume`

Streams the stored resume with its original filename. The stored name is resolved
against the upload directory and any path that escapes it is refused.

---

## Rate limits

Per IP, in a 15-minute window by default (`RATE_LIMIT_WINDOW_MINUTES`):

| Scope | Default |
| --- | --- |
| All `/api` requests | 100 (`RATE_LIMIT_MAX_REQUESTS`) |
| `POST /enquiries` | 5 (`FORM_RATE_LIMIT_MAX`) |
| `POST /applications` | 5 (`FORM_RATE_LIMIT_MAX`, counted separately) |
| `POST /admin/auth/login` | 10 (`LOGIN_RATE_LIMIT_MAX`) |

Beyond the limiters, the database is checked directly: 8 enquiries per IP per hour and
5 applications per IP per day.

Set `TRUST_PROXY=1` in production. Without it every request behind Hostinger's proxy
appears to come from the same address, and one visitor can exhaust the limit for everyone.
