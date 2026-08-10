import { config } from '../../../config/env';
import { escapeHtml } from '../../../utils/text';
import { BRAND } from './brand';

/**
 * The shared email footer.
 *
 * Only company details that already exist in the content document appear here — name,
 * tagline, the Coimbatore address, the two published phone numbers and the site URL.
 * No social links, certifications or statistics: if it is not in `docs/content-map.md`
 * it does not belong in an email either.
 */
export function renderFooter(year: number): string {
  const { colours } = BRAND;
  const siteHost = config.appUrl.replace(/^https?:\/\//, '');

  return `
          <tr>
            <td style="background-color:${colours.panel};padding:22px 28px;border-top:1px solid ${colours.line};color:${colours.muted};font-size:12px;line-height:1.7;">
              <div style="color:${colours.ink};font-size:13px;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;">
                ${escapeHtml(BRAND.name)}
              </div>
              <div style="margin-top:2px;color:${colours.muted};font-size:12px;">
                ${escapeHtml(BRAND.tagline)}
              </div>
              <div style="margin-top:12px;">
                ${escapeHtml(BRAND.address)}
              </div>
              <div>
                ${BRAND.phones.map((phone) => escapeHtml(phone)).join(' &nbsp;·&nbsp; ')}
              </div>
              <div style="margin-top:4px;">
                <a href="${escapeHtml(config.appUrl)}" style="color:${colours.navySoft};text-decoration:underline;">${escapeHtml(siteHost)}</a>
              </div>
              <div style="margin-top:14px;padding-top:12px;border-top:1px solid ${colours.line};font-size:11px;color:${colours.muted};">
                &copy; ${year} ${escapeHtml(BRAND.name)}. All rights reserved.
              </div>
            </td>
          </tr>`;
}
