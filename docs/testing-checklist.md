# Testing checklist

Run through this before each release, and in full after the first production deployment.

## Automated

```bash
npm run typecheck              # frontend + backend
npm --prefix frontend run lint
npm --prefix frontend run build
npm --prefix backend run build
```

The frontend build fails on any TypeScript error, so a green build means every page
compiles and every route was exported.

## Pages

| Route | Check |
| --- | --- |
| `/` | Hero, animated counters (1000+/250+/100+), three vertical cards, contribution grid, why-choose list, vision/mission, values, group sectors, CTA |
| `/about` | Who we are, founders, statistics, government contribution, vision, six mission points, eight core values |
| `/business` | Three vertical cards with service lists, group sectors section (`#sectors` anchor from the footer) |
| `/business/jmk-academy` | CAD group with the **Visit CAD DESK Coimbatore** external link, SAP modules (ABAP, BASIS, FICO, MM, SD, CSM), Zoho Book |
| `/business/jmk-design-studio` | All seven design services |
| `/business/jmk-software-solutions` | Build / Operate / Infrastructure groups, ERP examples listed |
| `/gallery` | Category filters change the grid; placeholders render, no invented captions |
| `/careers` | Five role groups covering all 13 roles, five benefits, application form |
| `/contact` | Address, both phone numbers, email, social links, form, map area |
| `/privacy-policy`, `/terms` | Render with correct headings and working cross-links |
| Any unknown URL | Branded 404 with working navigation |

## Forms

- [ ] Floating **Enquire Now** button is visible on every page, desktop and mobile
- [ ] Modal traps focus, closes on Escape, on backdrop click and on the close button
- [ ] Focus returns to the button that opened the modal
- [ ] Submitting empty shows one message per required field
- [ ] Invalid email, short message and bad phone each produce a specific message
- [ ] Valid submission shows the success message and clears the form
- [ ] Contact page form behaves identically
- [ ] Career form rejects a file over 5 MB, and a `.exe` renamed to `.pdf`
- [ ] Career form accepts a real PDF and reports success
- [ ] With the API stopped, forms show the network error rather than hanging

## Backend

- [ ] `GET /api/health` returns `ok`
- [ ] Submissions appear in `enquiries` / `job_applications`
- [ ] `info@jmkglobalholdings.com` receives the notification
- [ ] The submitter receives the auto-reply
- [ ] With SMTP misconfigured, the submission still saves and the user still sees success
- [ ] `notification_sent` / `autoreply_sent` reflect what really happened
- [ ] Resume files land in the storage directory with generated names
- [ ] The storage directory is not reachable over HTTP

## Security

- [ ] `.env` files are absent from `git status` and from the GitHub repository
- [ ] `/admin/enquiries` shows only the login form when signed out
- [ ] A wrong password is rejected with a generic message
- [ ] Rapid failed sign-ins hit the rate limit
- [ ] Repeated enquiry submissions hit the rate limit
- [ ] `<script>alert(1)</script>` in a message is stored and displayed as text everywhere, including the notification email
- [ ] `' OR 1=1 --` in the admin search returns no rows and causes no error
- [ ] Requests from an unlisted origin are refused by CORS
- [ ] A status change without the `X-CSRF-Token` header returns 403
- [ ] Resume download requires a session
- [ ] Error responses contain no stack traces or SQL text

## Responsive

Check 1920, 1440, 1024, 768, 480, 390 and 360 px wide.

- [ ] No horizontal scrollbar at any width
- [ ] Header collapses to the drawer below 1040 px; the drawer scrolls and closes on navigation
- [ ] Hero text stays readable; buttons wrap rather than overflow
- [ ] Statistics stack cleanly on mobile
- [ ] Cards and grids reflow to one column
- [ ] Form fields are full width and comfortably tappable
- [ ] The floating button becomes a circular icon below 480 px and never covers the footer's links
- [ ] Admin tables scroll horizontally inside their container rather than stretching the page

## Accessibility

- [ ] Every page has exactly one `<h1>` and a sensible heading order
- [ ] Tab order is logical; every interactive element shows a visible focus ring
- [ ] The skip link appears on first Tab and jumps to the main content
- [ ] All form fields have associated labels; errors are announced (`role="alert"`)
- [ ] Icon-only buttons have accessible names
- [ ] Decorative SVGs are `aria-hidden`
- [ ] With reduced motion enabled, reveals and counters resolve instantly
- [ ] Text contrast meets WCAG AA (gold is used on navy or as `--color-accent-ink` on light backgrounds)

## SEO

- [ ] Every page has a unique title and meta description
- [ ] Canonical URLs use `https://www.jmkglobalholdings.com`
- [ ] `og:image` resolves to the generated 1200×630 PNG
- [ ] `/sitemap.xml` lists all 10 public pages; `/robots.txt` disallows `/admin/`
- [ ] Organization, WebSite, LocalBusiness and BreadcrumbList JSON-LD validate in the Rich Results Test
- [ ] No page claims a fact absent from `docs/content-map.md`

## Performance

- [ ] Lighthouse (mobile) — Performance, Accessibility, Best Practices and SEO all ≥ 90
- [ ] Only the four client components ship JavaScript (header, enquiry modal, gallery filter, admin)
- [ ] `_next/static` assets are served with a long cache lifetime; HTML revalidates
