'use client';

import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { shortCalendarDate, type PayrollExclusion, type PayrollRun } from '@/lib/hrPayroll';
import { Pager } from '../../telecalling/shared';
import { plural } from './shared';

/**
 * Who the last calculation left out of a pay period, and why — by name.
 *
 * "0 employees" on its own sent people looking for a bug: somebody who worked seven
 * minutes is not on the payslips because they have no salary structure, and this card
 * is where that is said, next to the button that fixes it.
 *
 *   no_structure            no salary structure at all
 *   structure_starts_later  a structure exists, but it starts after the period ends —
 *                           payroll uses the structure in force on the period's last day
 *
 * The list arrives whole with the period (the server stores it with the calculation, at
 * most everyone employed in it); it is SHOWN ten at a time so a period that left out the
 * whole company is still a short card.
 */

const PAGE_SIZE = 10;

function reasonText(person: PayrollExclusion): string {
  if (person.reason === 'no_structure') return 'No salary structure yet';
  return person.structureFrom
    ? `Salary starts on ${shortCalendarDate(person.structureFrom)}, after this period ends`
    : 'Salary starts after this period ends';
}

export function NotIncludedCard({
  run,
  onOpenEmployee,
}: {
  run: PayrollRun;
  /** Opens Salary structures on this person. */
  onOpenEmployee: (person: PayrollExclusion) => void;
}) {
  const [page, setPage] = useState(1);

  const people = run.exclusions;
  const totalPages = Math.max(1, Math.ceil(people.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const shown = people.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  const approved = run.status === 'approved';
  const nobody = run.employeeCount === 0;
  const count = people.length;

  return (
    <section className="tc-card hr-pay-excluded" aria-labelledby="hr-pay-excluded-title">
      <h3 className="hr-pay-excluded__title" id="hr-pay-excluded-title">
        <Icon name="users" size={17} />
        Not included
        <span className="hr-pay-excluded__count">{count.toLocaleString('en-IN')}</span>
      </h3>

      <p className="hr-pay-excluded__intro">
        {nobody
          ? `Nobody is included in this calculation, and this is why: ${
              count === 1 ? 'the one person' : `all ${count.toLocaleString('en-IN')} people`
            } employed in this period ${count === 1 ? 'has' : 'have'} no salary structure that applies to it.`
          : `${plural(count, 'person', 'people')} employed in this period ${
              count === 1 ? 'has' : 'have'
            } no payslip in it.`}{' '}
        {approved
          ? 'This period is approved, so set them up before the next one.'
          : `Give each a salary structure that starts on or before ${shortCalendarDate(run.periodEnd)}, then recalculate.`}
      </p>

      <ul className="hr-pay-excluded__list">
        {shown.map((person) => (
          <li key={person.userId} className="hr-pay-excluded__item">
            <span className="hr-pay-excluded__who">
              <span className="hr-pay-excluded__name">{person.employeeName}</span>
              <span className="tc-muted tc-mono">{person.employeeCode}</span>
            </span>
            <span className="hr-pay-excluded__reason" data-reason={person.reason}>
              {reasonText(person)}
            </span>
            <button
              type="button"
              className={person.reason === 'no_structure' ? 'btn btn--primary btn--sm' : 'btn btn--outline btn--sm'}
              aria-label={`${person.reason === 'no_structure' ? 'Set up salary' : 'View salary'} for ${person.employeeName}`}
              onClick={() => onOpenEmployee(person)}
            >
              {person.reason === 'no_structure' ? 'Set up salary' : 'View salary'}
              <Icon name="arrowRight" size={14} />
            </button>
          </li>
        ))}
      </ul>

      {count > PAGE_SIZE ? (
        <Pager
          page={current}
          totalPages={totalPages}
          total={count}
          noun="person"
          nounPlural="people"
          onChange={setPage}
        />
      ) : null}
    </section>
  );
}
