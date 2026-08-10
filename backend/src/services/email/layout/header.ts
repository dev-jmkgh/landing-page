import { escapeHtml } from '../../../utils/text';
import { BRAND } from './brand';

/**
 * The shared email header.
 *
 * The website has no raster logo asset — its identity is a typographic wordmark — so
 * the header reproduces that wordmark in HTML rather than inventing a logo image. That
 * also sidesteps the usual problem with image-based email headers: most clients block
 * remote images by default, and a blocked logo leaves a branded email looking broken.
 */
export function renderHeader(title: string): string {
  const { colours } = BRAND;

  return `
          <tr>
            <td style="background-color:${colours.navy};padding:26px 28px;border-bottom:3px solid ${colours.accent};">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <div style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:0.5px;line-height:1.2;">
                      ${escapeHtml(BRAND.shortName)}<span style="color:${colours.accentSoft};">.</span>
                    </div>
                    <div style="color:#ffffff;font-size:15px;font-weight:600;letter-spacing:0.2px;margin-top:2px;">
                      ${escapeHtml(BRAND.name)}
                    </div>
                  </td>
                  <td align="right" style="vertical-align:middle;">
                    <div style="color:#b6c4d4;font-size:11px;letter-spacing:2px;text-transform:uppercase;">
                      ${escapeHtml(title)}
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`;
}
