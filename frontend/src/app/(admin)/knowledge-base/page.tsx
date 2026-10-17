import type { Metadata } from 'next';
import Link from 'next/link';

/**
 * The HR knowledge base: how the HR app and the HR admin screens are used, and by whom.
 *
 * A plain reading page at `/knowledge-base/`, deliberately not a section of the admin
 * application: there is nothing to load and nothing to sign in for, so it opens instantly
 * and can be linked from anywhere. It sits in the `(admin)` route group for that group's
 * layout — no marketing header or enquiry widget — and its `noindex`, and `robots.ts`
 * keeps crawlers away as well. It contains no data, only how things work.
 *
 * Keep it in step with the product. When a screen or a rule changes, change it here.
 */

export const metadata: Metadata = {
  // The root layout's template appends the company name.
  title: 'HR knowledge base',
  description: 'How employees, managers and administrators use the JMK HR app and admin portal.',
  robots: { index: false, follow: false, nocache: true },
};

const SECTIONS = [
  { id: 'roles', title: 'Who uses what' },
  { id: 'signup', title: 'Joining: sign-up and approval' },
  { id: 'employee', title: 'Employees: using the HR app' },
  { id: 'manager', title: 'Team managers and HR admins in the app' },
  { id: 'portal', title: 'The admin portal (HR)' },
  { id: 'access', title: 'Giving someone admin portal access' },
  { id: 'setup', title: 'First-time setup' },
  { id: 'monthly', title: 'Payroll: how a pay period works' },
  { id: 'automatic', title: 'What happens automatically' },
  { id: 'faq', title: 'Common questions' },
] as const;

export default function KnowledgeBasePage() {
  return (
    <main className="kb">
      <header className="kb__header">
        <p className="kb__eyebrow">JMK Global Holdings · HR</p>
        <h1>HR knowledge base</h1>
        <p className="kb__lead">
          How employees, team managers and administrators use the JMK HR app and the HR
          section of the admin portal.
        </p>
        <p className="kb__links">
          <Link href="/admin/hr/">Open the HR admin portal</Link>
        </p>
      </header>

      <nav className="kb__toc" aria-label="On this page">
        <p className="kb__toc-title">On this page</p>
        <ol>
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`}>{section.title}</a>
            </li>
          ))}
        </ol>
      </nav>

      <article className="kb__body">
        {/* ------------------------------------------------------------ roles */}
        <section id="roles">
          <h2>Who uses what</h2>
          <div className="kb__table-wrap">
            <table className="kb__table">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Where they work</th>
                  <th scope="col">What they can do</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><strong>Employee</strong></td>
                  <td>HR mobile app</td>
                  <td>Their own attendance, leave, payslips, HR requests, documents and profile.</td>
                </tr>
                <tr>
                  <td><strong>Team manager</strong> (app role “HR manager”)</td>
                  <td>HR mobile app</td>
                  <td>
                    Everything an employee can, plus approve their <em>direct reports’</em> leave
                    and attendance corrections, and see who in the team is in today.
                  </td>
                </tr>
                <tr>
                  <td><strong>HR admin</strong> (app role “HR admin”)</td>
                  <td>HR mobile app</td>
                  <td>The same as a team manager, but for every employee.</td>
                </tr>
                <tr>
                  <td><strong>Administrator</strong> (portal role admin)</td>
                  <td>Admin portal → HR</td>
                  <td>
                    Everything: set-up, approvals, corrections, payroll, reports and the audit
                    log.
                  </td>
                </tr>
                <tr>
                  <td><strong>Manager / supervisor</strong> (portal role)</td>
                  <td>Admin portal → HR</td>
                  <td>View only. No changes, and no payroll or audit log.</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="kb__note">
            The app and the portal are separate. Giving someone the “HR admin” role in the app
            lets them approve in the app; it does not let them into the admin portal. See{' '}
            <a href="#access">Giving someone admin portal access</a>.
          </p>
          <p className="kb__note">
            The HR app and the telecaller app are separate products with separate accounts. A
            telecaller who also needs the HR app has an HR account of their own, with its own
            password. They appear under HR → Employees only once that account exists.
          </p>
        </section>

        {/* ----------------------------------------------------------- signup */}
        <section id="signup">
          <h2>Joining: sign-up and approval</h2>
          <ol>
            <li>
              <strong>Create an account</strong> in the HR app: full name, work email, mobile
              number (a 10-digit Indian mobile, one account per number), and a password of at
              least 12 characters, typed twice.
            </li>
            <li>
              <strong>Confirm the email address</strong> with the six-digit code that is emailed.
              The code lasts 10 minutes; a new one can be requested after a minute.
            </li>
            <li>
              <strong>Wait for approval.</strong> An administrator approves the account in the
              portal (HR → Employees → Pending approval). An account cannot be approved until
              its email is confirmed.
            </li>
            <li>
              <strong>Sign in.</strong> Someone who confirmed nothing yet is taken back to the
              code screen when they try.
            </li>
          </ol>
          <p>
            Alternatively an administrator adds the employee directly (HR → Employees → Add
            employee) with a starting password; that account is approved and active at once.
          </p>
          <p>
            Either way, an administrator then sets the employee’s <strong>attendance rule</strong>{' '}
            (workplace, shift, office / remote / field). An office worker without a workplace
            cannot check in.
          </p>
        </section>

        {/* --------------------------------------------------------- employee */}
        <section id="employee">
          <h2>Employees: using the HR app</h2>

          <h3>Home</h3>
          <p>
            Today’s check-in and hours worked, a prompt if a check-out was missed, leave
            balances, pending requests, notifications, the latest payslip, upcoming holidays and
            quick links.
          </p>

          <h3>Attendance</h3>
          <ul>
            <li>
              <strong>Check in and out</strong> as often as needed in a day — out for lunch and
              back in counts as two sessions of one day.
            </li>
            <li>
              <strong>Location:</strong> office workers must be inside their workplace’s radius.
              Remote and field workers are not location-checked, and nor is anyone on an approved
              work-from-home or field-work day. Location is read only at the moment of a punch.
            </li>
            <li>
              <strong>History and month calendar:</strong> every day shown as present, late, half
              day, absent, on leave, holiday or weekly off.
            </li>
            <li>
              <strong>Corrections:</strong> a forgotten punch is corrected with a request, up to
              30 days back. A missed check-out is closed automatically at zero hours and the app
              asks for a correction.
            </li>
            <li>
              <strong>Reminders</strong> (optional, on the Attendance screen): a reminder to
              check in after the shift starts, and to check out after it ends.
            </li>
          </ul>

          <h3>Leave</h3>
          <ul>
            <li>
              Balances per leave type. A type HR has not set a quota for shows “No fixed
              balance” rather than a number.
            </li>
            <li>
              Apply for leave, work from home or field work, for a range of dates or a half day.
              Before sending, the app shows how many working days it costs (weekly offs and
              holidays are free) and what will be left.
            </li>
            <li>Track requests, cancel pending ones (or approved ones not yet started), and see the holiday calendar.</li>
          </ul>

          <h3>Payslips</h3>
          <p>
            Each month’s payslip appears once payroll is approved: earnings, deductions, loss of
            pay days and net pay, with a <strong>Download PDF</strong> button.
          </p>

          <h3>HR requests, documents, notifications</h3>
          <ul>
            <li>
              Raise a request: <em>Update my details</em> (phone, address, emergency contact,
              date of birth — HR applies it), a letter, a pay question, an attendance, leave or IT
              issue, or anything else. Each request is a conversation with HR.
            </li>
            <li>Documents HR has shared — with everyone (a policy) or personally (an offer letter).</li>
            <li>
              Notifications for decisions, payslips, HR replies, announcements and missed
              check-outs.
            </li>
          </ul>

          <h3>Profile</h3>
          <p>
            The employment record (department, designation, manager, joining date, status) and
            personal details, with “Request a change” for anything that is wrong.
          </p>
        </section>

        {/* ---------------------------------------------------------- manager */}
        <section id="manager">
          <h2>Team managers and HR admins in the app</h2>
          <p>
            Team managers and HR admins get a <strong>My team</strong> area, reached from Home and
            from the Leave tab:
          </p>
          <ul>
            <li>
              <strong>Approvals</strong> — the team’s pending leave and attendance corrections,
              with Approve or Decline (declining asks for a reason). The employee is notified and
              the decision is recorded in the audit log.
            </li>
            <li>
              <strong>Today</strong> — who in the team is in, on leave, working from home, on
              field work, or not in yet.
            </li>
          </ul>
          <p>
            A team manager’s team is the employees whose manager is set to them (HR → Employees
            → Edit record → Manager). An HR admin’s team is everyone. Nobody can approve their
            own request. A role change takes effect the next time the person’s app refreshes its
            sign-in (within a few minutes, or on next sign-in).
          </p>
        </section>

        {/* ----------------------------------------------------------- portal */}
        <section id="portal">
          <h2>The admin portal (HR)</h2>
          <div className="kb__table-wrap">
            <table className="kb__table">
              <thead>
                <tr>
                  <th scope="col">Section</th>
                  <th scope="col">What it is for</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><strong>Dashboard</strong></td>
                  <td>
                    Today at a glance — present, late, on leave, not yet in — what needs a
                    decision, a 14-day trend, headcount by department, and the last payroll
                    (administrators only).
                  </td>
                </tr>
                <tr>
                  <td><strong>Employees</strong></td>
                  <td>
                    Approve or reject sign-ups; add employees; edit records (department,
                    designation, manager, joining date, access role, employment status); set the
                    attendance rule; switch accounts off. Each record has attendance, calendar and
                    leave-balance tabs.
                  </td>
                </tr>
                <tr>
                  <td><strong>Attendance</strong></td>
                  <td>
                    The daily register with filters; <em>Correct day</em> (requires a reason,
                    audited); <em>Exceptions</em> — punches flagged for a mock location, a wrong
                    phone clock or poor GPS, and missed check-outs, to review.
                  </td>
                </tr>
                <tr>
                  <td><strong>Corrections</strong></td>
                  <td>Approve or reject employees’ attendance correction requests.</td>
                </tr>
                <tr>
                  <td><strong>Leave</strong></td>
                  <td>
                    Approve or reject leave; set an employee’s balance for a year; leave types and
                    annual quotas; holidays.
                  </td>
                </tr>
                <tr>
                  <td><strong>Requests</strong></td>
                  <td>
                    Reply to HR requests and move them through in progress, resolved or rejected.
                    Resolving a profile update applies the change to the employee’s record.
                  </td>
                </tr>
                <tr>
                  <td><strong>Documents</strong></td>
                  <td>
                    Share PDFs or images with everyone or with one employee; send announcements to
                    everyone or to a department.
                  </td>
                </tr>
                <tr>
                  <td><strong>Payroll</strong> (administrators only)</td>
                  <td>
                    Salary structures per employee; pay periods — open one, calculate payslips
                    at any time to see the figures so far, approve after it ends to publish
                    them; the pay cycle (e.g. 26th to 25th); CSV export and payslip PDFs.
                  </td>
                </tr>
                <tr>
                  <td><strong>Reports</strong></td>
                  <td>
                    Attendance summary, daily attendance, leave, employee list and payroll
                    (administrators only), each with a CSV download.
                  </td>
                </tr>
                <tr>
                  <td><strong>Workplaces</strong></td>
                  <td>
                    Sites with a map point and an allowed radius; shifts with times, a grace
                    period and weekly off days.
                  </td>
                </tr>
                <tr>
                  <td><strong>Organisation</strong></td>
                  <td>
                    Departments and designations; HR settings — the date attendance tracking
                    starts, and the default weekly off.
                  </td>
                </tr>
                <tr>
                  <td><strong>Audit log</strong> (administrators only)</td>
                  <td>Who changed or approved what, and when.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* ----------------------------------------------------------- access */}
        <section id="access">
          <h2>Giving someone admin portal access</h2>
          <p>
            A portal login is created by a developer on the server, from the backend folder.
            The first command creates the login and asks for a password; the second gives it a
            role:
          </p>
          <pre className="kb__code">
            <code>
              npm run admin:password -- officer@jmkglobalholdings.com --create{'\n'}
              npm run admin:link -- officer@jmkglobalholdings.com --name &quot;Officer Name&quot; --role admin
            </code>
          </pre>
          <p>
            Use <code>--role supervisor</code> for view-only access. The same login also opens
            the telecalling admin screens, because the portal has one administrator identity for
            both.
          </p>
        </section>

        {/* ------------------------------------------------------------ setup */}
        <section id="setup">
          <h2>First-time setup</h2>
          <ol>
            <li>
              <strong>Organisation:</strong> add departments and designations. Set “Attendance
              tracked from” to the go-live date, so calendars show earlier days as “Not tracked”.
              Payroll still counts them as absent; pay somebody in full if they should be paid.
            </li>
            <li>
              <strong>Workplaces:</strong> add office sites and shifts — with weekly offs and the
              day rules (e.g. 7h a full day, 3h 30m a half day, less is absent).
            </li>
            <li>
              <strong>Employees:</strong> approve sign-ups or add people; fill in each record
              (department, designation, manager, joining date) and set the attendance rule.
            </li>
            <li>
              <strong>Leave:</strong> set annual quotas on the leave types — they start with none
              — and add the year’s holidays.
            </li>
            <li>
              <strong>Payroll:</strong> choose the pay cycle (calendar month, or e.g. 26th to
              25th), and add a salary structure for each employee — effective from the first
              day you want them paid from.
            </li>
          </ol>
        </section>

        {/* ---------------------------------------------------------- monthly */}
        <section id="monthly">
          <h2>Payroll: how a pay period works</h2>
          <p>
            A <strong>pay period</strong> is one salary cycle for everybody — the calendar
            month by default, or a common range such as the 26th to the 25th (Payroll → pay
            cycle). It is named after the month it ends in, so with a 26th start the
            “October” period runs 26 September to 25 October. Its dates are fixed when it is
            opened.
          </p>
          <ol>
            <li>
              <strong>Salary structures.</strong> Each employee needs one: their monthly
              earnings and deductions, effective from a date. Somebody without a structure in
              force by the period’s last day is not paid in it — the period lists them under
              <em> Not included</em>, with the reason.
            </li>
            <li>
              <strong>Open the pay period</strong> (Payroll → New pay period) any time after
              it has started.
            </li>
            <li>
              <strong>Calculate payslips</strong> as often as you like. While the period is
              still running the figures are <em>provisional</em>: they cover the days up to
              today, and the days still to come are neither paid nor counted as loss of pay
              yet. An employee who has worked today already shows as present today.
            </li>
            <li>
              <strong>After the period ends</strong>, recalculate once more and{' '}
              <strong>Approve and publish</strong>. Employees are notified and can download
              their payslips. An approved period is final — it cannot be recalculated or
              deleted — and it can only be approved from figures that cover every day.
            </li>
          </ol>
          <p>
            Loss of pay counts absent days and unpaid leave — every working day with no
            attendance and no leave is absent, including days before attendance tracking began.
            Weekly offs, holidays and paid leave are paid. To pay one employee for the whole
            period anyway, open their payslip and choose <strong>Pay in full</strong>: admins only,
            with a reason, recorded in the audit log, and undoable until the period is approved. Each shift has two day rules, judged after the day is over (a nightly
            job just after midnight): worked at least the <em>full-day</em> minimum is a full day;
            at least the <em>half-day</em> minimum is a half day (half of it loss of pay unless
            half-day leave covers it); less than that is absent. Until midnight a day shows as
            present or late, so checking out for lunch, or starting late and staying on to make up
            the hours, is never marked short early. Changing a shift’s day rules re-judges the
            finished days on it, except days in an approved pay period. For somebody who joined or left during the period, the days outside
            their employment are not paid and are shown separately from loss of pay.
          </p>
        </section>

        {/* -------------------------------------------------------- automatic */}
        <section id="automatic">
          <h2>What happens automatically</h2>
          <ul>
            <li>
              A check-out forgotten overnight is closed at zero hours, the day is marked as a
              missing punch, and the employee is asked to request a correction.
            </li>
            <li>
              Check-in and check-out reminders are written to the app’s notification inbox
              (production servers), in addition to any reminders an employee turned on in the
              app.
            </li>
            <li>Every administrative change and every approval is written to the audit log.</li>
          </ul>
        </section>

        {/* -------------------------------------------------------------- faq */}
        <section id="faq">
          <h2>Common questions</h2>
          <dl className="kb__faq">
            <dt>Somebody is missing from HR → Employees.</dt>
            <dd>
              They have no HR account yet. Telecalling accounts are separate; the person signs up
              in the HR app, or an administrator adds them with Add employee. Pending sign-ups are
              under the Pending approval tab.
            </dd>

            <dt>An office worker cannot check in.</dt>
            <dd>
              Either no workplace is set (HR → Employees → Attendance rule) or they are outside
              the radius — the app says how far away they are. For a day out of the office,
              approve a work-from-home or field-work request.
            </dd>

            <dt>A leave type shows no balance.</dt>
            <dd>
              No annual quota is set for it. Set one under Leave → Leave types, or a balance for
              one person under Leave → Balances.
            </dd>

            <dt>Somebody is missing from a pay period.</dt>
            <dd>
              Look at <em>Not included</em> on the period: usually they have no salary
              structure, or it starts after the period ends. Add or correct the structure, then
              recalculate.
            </dd>

            <dt>Approve is disabled.</dt>
            <dd>
              The period has not ended yet, or its figures were calculated before it ended.
              Recalculate on or after the day after it ends, then approve.
            </dd>

            <dt>The app says “No connection”.</dt>
            <dd>
              The phone cannot reach the server. In local testing, check the development tunnel
              or the USB cable; in production, the phone’s internet connection.
            </dd>
          </dl>
        </section>
      </article>
    </main>
  );
}
