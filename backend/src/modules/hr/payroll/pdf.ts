/**
 * A tiny, dependency-free PDF 1.4 writer — exactly what a payslip needs and no more:
 * text in Helvetica / Helvetica-Bold, straight lines, filled rectangles, A4 pages.
 *
 * WHY HAND-WRITTEN. A payslip is a fixed, simple document, and a PDF library would be
 * the largest dependency in the API for one page of text. The format's core is small:
 * a header, numbered objects, a cross-reference table of each object's BYTE offset, and
 * a trailer. Getting those offsets exactly right is the whole job (a viewer that finds
 * one wrong either repairs the file silently or refuses it), so they are computed from
 * the bytes actually written, in latin1, and the e2e re-checks every one.
 *
 * WHAT IT DOES NOT DO, deliberately:
 *   - No font embedding. Helvetica is one of the 14 standard fonts every viewer has.
 *   - No compression. Streams are plain text, so the content is greppable in a test.
 *   - No Unicode. Text is WinAnsi (Latin-1 range): anything outside it becomes '?', so
 *     "₹" can never print as garbage — callers write "INR".
 *
 * COORDINATES are TOP-LEFT based, in points, y growing DOWN — the way a layout is
 * written — and converted to PDF's bottom-left origin here. A text `y` is its baseline.
 */

export type Rgb = readonly [number, number, number];
export type PdfFont = 'regular' | 'bold';

export const A4 = { width: 595, height: 842 } as const;

const FONT_RESOURCE: Record<PdfFont, string> = { regular: 'F1', bold: 'F2' };
const BASE_FONT: Record<PdfFont, string> = { regular: 'Helvetica', bold: 'Helvetica-Bold' };

/*
 * Advance widths (1/1000 em) for WinAnsi codes 32..126, from Adobe's standard AFM files.
 * Used only to right-align and centre text, so an approximation for the accented
 * Latin-1 range (160..255, measured as 556) costs at most a point of alignment.
 */
// prettier-ignore
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // 32-47
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 48-63
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // 64-79
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // 80-95
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // 96-111
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,      // 112-126
];
// prettier-ignore
const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, // 32-47
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, // 48-63
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, // 64-79
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, // 80-95
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, // 96-111
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,      // 112-126
];
const FALLBACK_WIDTH = 556;

/**
 * Text the PDF can carry: printable ASCII and Latin-1 (U+00A0..U+00FF) pass through,
 * line breaks and tabs become spaces, everything else — C1 controls, "₹", emoji, any
 * non-Latin script — becomes '?'. Iterates code points, so an emoji is ONE '?'.
 */
export function pdfSafeText(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0x3f;
    if (code === 0x09 || code === 0x0a || code === 0x0d) out += ' ';
    else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) out += char;
    else out += '?';
  }
  return out;
}

/** A PDF literal string body: backslash and both parentheses escaped. Input must be safe text. */
function escapeLiteral(value: string): string {
  return value.replace(/[\\()]/g, (char) => `\\${char}`);
}

/** Width of SAFE text in points. */
export function textWidth(value: string, font: PdfFont, size: number): number {
  const table = font === 'bold' ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let units = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    units += code >= 32 && code <= 126 ? (table[code - 32] ?? FALLBACK_WIDTH) : FALLBACK_WIDTH;
  }
  return (units / 1000) * size;
}

/** Shortens text with "..." until it fits `maxWidth` points. */
export function fitText(value: string, maxWidth: number, font: PdfFont, size: number): string {
  const safe = pdfSafeText(value);
  if (textWidth(safe, font, size) <= maxWidth) return safe;
  let cut = safe;
  while (cut.length > 0 && textWidth(`${cut}...`, font, size) > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}...`;
}

/** A number for a content stream: no exponent, at most two decimals, no trailing zeros. */
function num(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function rgb(color: Rgb): string {
  return color.map((part) => num(Math.min(1, Math.max(0, Math.round(part * 1000) / 1000)))).join(' ');
}

export class PdfPage {
  private readonly ops: string[] = [];

  constructor(readonly width: number = A4.width, readonly height: number = A4.height) {}

  /** Draws one line of text with its baseline at `y`. `align` is relative to `x`. */
  text(
    x: number,
    y: number,
    value: string,
    options: { font?: PdfFont; size?: number; color?: Rgb; align?: 'left' | 'right' | 'center' } = {},
  ): void {
    const font = options.font ?? 'regular';
    const size = options.size ?? 10;
    const safe = pdfSafeText(value);
    if (safe.length === 0) return;
    const width = textWidth(safe, font, size);
    const left = options.align === 'right' ? x - width : options.align === 'center' ? x - width / 2 : x;
    this.ops.push(
      `BT /${FONT_RESOURCE[font]} ${num(size)} Tf ${rgb(options.color ?? [0, 0, 0])} rg ` +
        `${num(left)} ${num(this.height - y)} Td (${escapeLiteral(safe)}) Tj ET`,
    );
  }

  line(x1: number, y1: number, x2: number, y2: number, options: { width?: number; color?: Rgb } = {}): void {
    this.ops.push(
      `q ${num(options.width ?? 0.5)} w ${rgb(options.color ?? [0, 0, 0])} RG ` +
        `${num(x1)} ${num(this.height - y1)} m ${num(x2)} ${num(this.height - y2)} l S Q`,
    );
  }

  /** A filled rectangle whose TOP-left corner is (x, y). */
  rect(x: number, y: number, width: number, height: number, options: { fill: Rgb }): void {
    this.ops.push(
      `q ${rgb(options.fill)} rg ${num(x)} ${num(this.height - y - height)} ${num(width)} ${num(height)} re f Q`,
    );
  }

  /** The page's content stream. */
  content(): string {
    return this.ops.join('\n');
  }
}

export class PdfDocument {
  private readonly pages: PdfPage[] = [];

  constructor(private readonly info: { title?: string; author?: string } = {}) {}

  addPage(): PdfPage {
    const page = new PdfPage();
    this.pages.push(page);
    return page;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  /**
   * Serialises the document.
   *
   * Object numbers are fixed: 1 catalog, 2 page tree, 3 Helvetica, 4 Helvetica-Bold,
   * 5 document info, then a page object and its content stream for each page. Every
   * string written is latin1-safe by construction (`pdfSafeText`), so one character is
   * one byte and `Buffer.byteLength(..., 'latin1')` is the true byte offset.
   */
  toBuffer(): Buffer {
    if (this.pages.length === 0) this.addPage();

    const objects: string[] = [];
    const pageObjectNumber = (index: number) => 6 + index * 2;

    objects.push('<< /Type /Catalog /Pages 2 0 R >>');
    objects.push(
      `<< /Type /Pages /Kids [${this.pages.map((_page, index) => `${pageObjectNumber(index)} 0 R`).join(' ')}] /Count ${this.pages.length} >>`,
    );
    for (const font of ['regular', 'bold'] as const) {
      objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /${BASE_FONT[font]} /Encoding /WinAnsiEncoding >>`);
    }
    const infoEntries = [
      this.info.title ? `/Title (${escapeLiteral(pdfSafeText(this.info.title))})` : '',
      this.info.author ? `/Author (${escapeLiteral(pdfSafeText(this.info.author))})` : '',
    ].filter(Boolean);
    objects.push(`<< ${infoEntries.join(' ')} >>`);

    this.pages.forEach((page, index) => {
      const stream = page.content();
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageObjectNumber(index) + 1} 0 R >>`,
      );
      // /Length counts the bytes between "stream\n" and the EOL before "endstream".
      objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    });

    // The second line is the customary binary marker, telling transfer tools the file is
    // binary so they do not "fix" its line endings and break every offset after them.
    const chunks: string[] = ['%PDF-1.4\n%âãÏÓ\n'];
    let offset = Buffer.byteLength(chunks[0]!, 'latin1');
    const offsets: number[] = [];

    objects.forEach((body, index) => {
      const chunk = `${index + 1} 0 obj\n${body}\nendobj\n`;
      offsets.push(offset);
      chunks.push(chunk);
      offset += Buffer.byteLength(chunk, 'latin1');
    });

    // Each xref entry is exactly 20 bytes: 10-digit offset, 5-digit generation, flag, " \n".
    const xref = [
      'xref',
      `0 ${objects.length + 1}`,
      '0000000000 65535 f ',
      ...offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n `),
    ].join('\n');
    chunks.push(
      `${xref}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
    );

    return Buffer.from(chunks.join(''), 'latin1');
  }
}
