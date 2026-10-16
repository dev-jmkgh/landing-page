import type { HrFileContent } from '../files/hrFileLinks';
import { A4, PdfDocument, fitText, type PdfPage, type Rgb } from './pdf';
import { COMPANY_NAME, formatInr, monthLabel, type Payslip, type PayslipLine } from './payroll.schema';
import { findPayslipForEmployee, payslipFilename } from './payroll.service';

/**
 * The payslip as a one- (occasionally two-) page A4 PDF, drawn with `pdf.ts`.
 *
 * Everything printed comes from the stored payslip — its snapshots, day counts and
 * lines — never from the live employee record or structure, so a payslip downloaded a
 * year later says what it said the day it was approved.
 *
 * Amounts are printed with Indian digit grouping and "INR" (the rupee sign is outside
 * the standard PDF fonts' character set). No signature image: the footer says the
 * document is system-generated, which is what it is.
 */

const BRAND: Rgb = [0.035, 0.455, 0.69]; // #0974B0, the HR app's brand blue
const INK: Rgb = [0.12, 0.14, 0.17];
const MUTED: Rgb = [0.4, 0.43, 0.48];
const RULE: Rgb = [0.84, 0.86, 0.89];
const BAND: Rgb = [0.955, 0.96, 0.97];
const TINT: Rgb = [0.91, 0.95, 0.98];
const WHITE: Rgb = [1, 1, 1];

const LEFT = 40;
const RIGHT = A4.width - 40;
const WIDTH = RIGHT - LEFT;
/** Content stops here; below is the footer. */
const BOTTOM = 772;
const TOP_OF_CONTINUATION = 56;

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return `${day} ${SHORT_MONTHS[month - 1] ?? ''} ${year}`;
}

const paise = (amount: number) => Math.round(amount * 100);
const inr = (amount: number) => formatInr(paise(amount));
const dayCount = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));

export function buildPayslipPdf(slip: Payslip): Buffer {
  const document = new PdfDocument({
    title: `Payslip ${monthLabel(slip.period)} - ${slip.employeeName} (${slip.employeeCode})`,
    author: COMPANY_NAME,
  });
  const pages: PdfPage[] = [document.addPage()];
  let page = pages[0]!;
  let y = 0;

  /** Starts a new page when `height` more points would run into the footer. */
  const room = (height: number) => {
    if (y + height <= BOTTOM) return;
    page = document.addPage();
    pages.push(page);
    y = TOP_OF_CONTINUATION;
  };

  const sectionTitle = (title: string) => {
    room(40);
    page.text(LEFT, y, title, { font: 'bold', size: 11, color: INK });
    page.line(LEFT, y + 6, RIGHT, y + 6, { color: RULE, width: 0.75 });
    y += 22;
  };

  /* ---------------------------------------------------------------- header */
  page.rect(0, 0, A4.width, 88, { fill: BRAND });
  page.text(LEFT, 40, COMPANY_NAME, { font: 'bold', size: 18, color: WHITE });
  page.text(LEFT, 64, `Payslip for ${monthLabel(slip.period)}`, { size: 12, color: WHITE });
  page.text(RIGHT, 40, 'Net pay', { size: 9, color: WHITE, align: 'right' });
  page.text(RIGHT, 64, `INR ${inr(slip.netPay)}`, { font: 'bold', size: 15, color: WHITE, align: 'right' });
  y = 120;

  /* -------------------------------------------------------------- employee */
  sectionTitle('Employee');
  const pairs: Array<[string, string, string, string]> = [
    ['Employee name', slip.employeeName, 'Employee code', slip.employeeCode],
    ['Department', slip.departmentName ?? 'Not recorded', 'Designation', slip.designationName ?? 'Not recorded'],
    ['Pay period', `${shortDate(slip.periodStart)} to ${shortDate(slip.periodEnd)}`, 'Days in period', dayCount(slip.daysInPeriod)],
  ];
  for (const [leftLabel, leftValue, rightLabel, rightValue] of pairs) {
    room(16);
    page.text(LEFT, y, leftLabel, { size: 8.5, color: MUTED });
    page.text(LEFT + 88, y, fitText(leftValue, 170, 'regular', 10), { size: 10, color: INK });
    page.text(LEFT + 270, y, rightLabel, { size: 8.5, color: MUTED });
    page.text(LEFT + 358, y, fitText(rightValue, WIDTH - 358, 'regular', 10), { size: 10, color: INK });
    y += 17;
  }
  y += 10;

  /* ------------------------------------------------------------ attendance */
  sectionTitle('Attendance');
  const cells: Array<[string, number]> = [
    ['Days in period', slip.daysInPeriod],
    ['Paid days', slip.paidDays],
    ['Loss-of-pay days', slip.lopDays],
    ['Present', slip.presentDays],
    ['Paid leave', slip.paidLeaveDays],
    ['Unpaid leave', slip.unpaidLeaveDays],
    ['Absent', slip.absentDays],
    ['Holidays', slip.holidayDays],
    ['Weekly offs', slip.weeklyOffDays],
  ];
  // Shown only when they apply, so the counts above still add up to the month for the reader.
  if (slip.unemployedDays > 0) cells.push(['Not employed', slip.unemployedDays]);
  if (slip.untrackedDays > 0) cells.push(['Not tracked (paid)', slip.untrackedDays]);

  const columnWidth = WIDTH / 3;
  const rows = Math.ceil(cells.length / 3);
  room(rows * 18 + 8);
  page.rect(LEFT, y - 13, WIDTH, rows * 18 + 6, { fill: BAND });
  cells.forEach(([label, value], index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const x = LEFT + column * columnWidth + 8;
    const baseline = y + row * 18;
    page.text(x, baseline, label, { size: 9, color: MUTED });
    page.text(x + columnWidth - 22, baseline, dayCount(value), { font: 'bold', size: 10, color: INK, align: 'right' });
  });
  y += rows * 18 + 16;

  /* -------------------------------------------------------------- tables */
  const earnings = slip.lines.filter((line) => line.kind === 'earning');
  const deductions = slip.lines.filter((line) => line.kind === 'deduction');
  const FULL_COLUMN = RIGHT - 110;
  const PAID_COLUMN = RIGHT - 6;

  const tableHeader = (title: string, columns: Array<[string, number]>) => {
    room(18 + 16);
    page.rect(LEFT, y - 12, WIDTH, 18, { fill: BAND });
    page.text(LEFT + 6, y, title, { font: 'bold', size: 9.5, color: INK });
    for (const [label, x] of columns) page.text(x, y, label, { font: 'bold', size: 9, color: INK, align: 'right' });
    y += 20;
  };

  const tableRow = (label: string, values: Array<[string, number]>, bold = false) => {
    room(16);
    const font = bold ? 'bold' : 'regular';
    page.text(LEFT + 6, y, fitText(label, FULL_COLUMN - 130 - LEFT, font, 9.5), { font, size: 9.5, color: INK });
    for (const [value, x] of values) page.text(x, y, value, { font, size: 9.5, color: INK, align: 'right' });
    page.line(LEFT, y + 5, RIGHT, y + 5, { color: RULE, width: 0.5 });
    y += 16;
  };

  const sum = (lines: PayslipLine[], pick: (line: PayslipLine) => number) =>
    lines.reduce((total, line) => total + paise(pick(line)), 0);

  sectionTitle('Earnings');
  tableHeader('Component', [
    ['Full month (INR)', FULL_COLUMN],
    ['Paid (INR)', PAID_COLUMN],
  ]);
  if (earnings.length === 0) tableRow('No earnings', []);
  for (const line of earnings) {
    tableRow(line.label, [
      [inr(line.fullAmount), FULL_COLUMN],
      [inr(line.amount), PAID_COLUMN],
    ]);
  }
  tableRow(
    'Gross earnings',
    [
      [formatInr(sum(earnings, (line) => line.fullAmount)), FULL_COLUMN],
      [inr(slip.grossEarnings), PAID_COLUMN],
    ],
    true,
  );
  y += 14;

  sectionTitle('Deductions');
  tableHeader('Component', [['Amount (INR)', PAID_COLUMN]]);
  if (deductions.length === 0) tableRow('No deductions', [['0.00', PAID_COLUMN]]);
  for (const line of deductions) tableRow(line.label, [[inr(line.amount), PAID_COLUMN]]);
  tableRow('Total deductions', [[inr(slip.totalDeductions), PAID_COLUMN]], true);
  y += 18;

  /* --------------------------------------------------------------- totals */
  room(96);
  const boxTop = y - 14;
  page.rect(LEFT, boxTop, WIDTH, 74, { fill: TINT });
  const totalRow = (label: string, value: string, emphasis = false) => {
    const size = emphasis ? 12.5 : 10;
    const font = emphasis ? 'bold' : 'regular';
    page.text(LEFT + 12, y, label, { font, size, color: emphasis ? BRAND : INK });
    page.text(RIGHT - 12, y, value, { font, size, color: emphasis ? BRAND : INK, align: 'right' });
  };
  totalRow('Gross earnings', `INR ${inr(slip.grossEarnings)}`);
  y += 18;
  totalRow('Total deductions', `INR ${inr(slip.totalDeductions)}`);
  page.line(LEFT + 12, y + 8, RIGHT - 12, y + 8, { color: RULE, width: 0.75 });
  y += 26;
  totalRow('Net pay', `INR ${inr(slip.netPay)}`, true);
  y = boxTop + 74 + 16;

  if (slip.lopAmount > 0) {
    room(14);
    page.text(
      LEFT,
      y,
      `Loss of pay of INR ${inr(slip.lopAmount)} for ${dayCount(slip.lopDays)} day${slip.lopDays === 1 ? '' : 's'} is already reflected in the earnings above.`,
      { size: 8.5, color: MUTED },
    );
    y += 14;
  }

  /* --------------------------------------------------------------- footer */
  pages.forEach((each, index) => {
    each.line(LEFT, 796, RIGHT, 796, { color: RULE, width: 0.5 });
    each.text(LEFT, 812, 'This is a system-generated payslip.', { size: 8.5, color: MUTED });
    if (pages.length > 1) {
      each.text(RIGHT, 812, `Page ${index + 1} of ${pages.length}`, { size: 8.5, color: MUTED, align: 'right' });
    }
  });

  return document.toBuffer();
}

/**
 * Renders a payslip PDF for the employee a file link was minted for, or null when it is
 * not theirs or its run is not approved. Called by `hrFileLinks.ts` when the link is
 * FOLLOWED, so a payslip whose run was deleted since the link was minted finds nothing.
 */
export async function renderPayslipForEmployee(
  payslipId: number,
  userId: number,
): Promise<HrFileContent | null> {
  const payslip = await findPayslipForEmployee(payslipId, userId);
  if (!payslip) return null;
  return {
    kind: 'buffer',
    body: buildPayslipPdf(payslip),
    filename: payslipFilename(payslip),
    mimeType: 'application/pdf',
  };
}
