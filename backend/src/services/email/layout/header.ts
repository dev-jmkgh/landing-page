import { escapeHtml } from '../../../utils/text';
import { BRAND } from './brand';
import { EMAIL_LOGO_CID } from './logo';

/**
 * The shared email header.
 *
 * The logo is embedded and referenced by Content-ID rather than linked, so it renders
 * without the recipient allowing remote images — see `logo.ts`. The wordmark below it
 * stays as text: it is the alt text if the image ever fails, and it keeps the company
 * name selectable and searchable rather than locked inside a picture.
 */
export function renderHeader(title: string): string {
  const { colours } = BRAND;

  return `
          <tr>
            <td style="background-color:${colours.navy};padding:26px 28px;border-bottom:3px solid ${colours.accent};">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <img
                      src="cid:${EMAIL_LOGO_CID}"
                      width="150"
                      alt="${escapeHtml(BRAND.name)}"
                      style="display:block;width:150px;max-width:150px;height:auto;border:0;outline:none;text-decoration:none;"
                    />
                    <div style="color:#b6c4d4;font-size:11px;letter-spacing:1.4px;text-transform:uppercase;margin-top:8px;">
                      ${escapeHtml(BRAND.tagline)}
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
