import { Router } from 'express';
import { config } from '../../config/env';
import { requireAuth } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/errorHandler';
import { loginLimiter } from '../../middleware/rateLimit';
import { notFound } from '../../utils/httpError';
import { logger } from '../../utils/logger';
import { renderEmail, renderText } from '../../services/email';
import { mailConfigReport, sendAdminNotification, verifyMailer } from '../../services/mailer';

/**
 * Mail diagnostics.
 *
 * Answers the one question that is otherwise very hard to answer from outside the
 * process: is Gmail actually accepting our messages, and where are they going? Without
 * this, a missing notification could equally be a wrong password, an unset environment
 * variable on the host, an empty recipient list, or a bug — and they all look the same.
 *
 * Access is deliberately narrow. In production both routes require an authenticated
 * admin session; in development they are open so the pipeline can be checked before any
 * admin account exists. Neither route ever returns a credential: the config report says
 * whether a password is present, never what it is.
 */

export const diagnosticsRouter = Router();

/**
 * Rejects the request in production unless an admin session is present. Development
 * keeps the routes reachable so `npm run dev` can verify SMTP immediately.
 */
const guard = config.isProduction ? [loginLimiter, requireAuth] : [];

/**
 * GET /api/diagnostics/mail
 *
 * Reports the effective mail configuration and runs `transporter.verify()`, which is
 * what distinguishes "the credentials are wrong" from "the application never tried".
 */
diagnosticsRouter.get(
  '/mail',
  ...guard,
  asyncHandler(async (_request, response) => {
    const verified = await verifyMailer();

    response.json({
      smtp: mailConfigReport(),
      verified,
      note: verified
        ? 'SMTP connection successful.'
        : 'SMTP connection failed or is not configured — see the backend logs for the reason.',
    });
  }),
);

/**
 * POST /api/diagnostics/mail/test
 *
 * Sends a real message to every address in ADMIN_EMAILS and reports the transport's
 * own verdict, so "it said sent" can be checked against what Gmail actually accepted.
 */
diagnosticsRouter.post(
  '/mail/test',
  ...guard,
  asyncHandler(async (request, response) => {
    if (config.mail.adminRecipients.length === 0) {
      throw notFound('No ADMIN_EMAILS are configured, so there is nowhere to send a test.');
    }

    const sentAt = new Date().toISOString();
    const body = 'This is a test email from JMK Global Holdings.';

    const result = await sendAdminNotification({
      type: 'smtp-test',
      subject: 'JMK SMTP Test',
      html: renderEmail({
        title: 'SMTP test',
        preheader: 'Test message from the JMK Global Holdings website backend.',
        content: `
              <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">${body}</p>
              <p style="margin:0;font-size:13px;color:#5b6572;">Sent at ${sentAt}</p>`,
      }),
      text: renderText([body, '', `Sent at ${sentAt}`]),
    });

    logger.info('SMTP test email requested', {
      result,
      by: request.admin?.email ?? 'development',
      recipients: config.mail.adminRecipients.length,
    });

    response.json({
      result,
      recipients: config.mail.adminRecipients.length,
      smtp: mailConfigReport(),
      note:
        result === 'sent'
          ? 'Gmail accepted the message for every recipient.'
          : result === 'partial'
            ? 'Gmail accepted the message for some recipients only — see the logs.'
            : result === 'skipped'
              ? 'SMTP is not configured, so nothing was sent.'
              : 'Gmail refused the message — see the backend logs for the reason.',
    });
  }),
);
