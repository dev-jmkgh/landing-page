import { renderEmail, renderText, type EmailDocument } from '../layout/base';
import { callout, paragraph, referenceBlock, signOff } from '../layout/components';

/**
 * The email carrying a registration's one-time verification code.
 *
 * Written for someone who has just tapped "Submit registration" on their phone and is
 * looking at a code entry box, so the code is the first thing in the message and the
 * only thing in the preheader — most recipients will read it from the notification
 * without opening anything.
 *
 * There is deliberately no link to click. A verification link in an email has to carry a
 * token in a URL, which then lives in browser history, in any link-scanning proxy the
 * mailbox sits behind, and in whatever the recipient pastes it into. The code is typed
 * into an app the person already has open, expires in minutes, and never leaves the two
 * places it belongs.
 */
export type EmployeeVerificationEmailData = {
  name: string;
  code: string;
  /** Minutes until the code expires, so the copy and the server cannot disagree. */
  expiresInMinutes: number;
};

export function employeeVerificationEmail(
  data: EmployeeVerificationEmailData,
): EmailDocument {
  const expiry = `This code expires in ${data.expiresInMinutes} minutes.`;

  return {
    // The code is not in the subject. Subject lines are shown in notifications on
    // lock screens and in shared or projected inboxes, and a verification code is the
    // one thing in this message that should not be readable without unlocking anything.
    subject: 'Verify your JMK Telecaller email address',
    html: renderEmail({
      title: 'Verify your email address',
      preheader: expiry,
      content: [
        paragraph(`Hello ${data.name},`),
        paragraph(
          'Enter this code in the JMK Telecaller app to confirm this is your email address.',
        ),
        referenceBlock('Your verification code:', data.code),
        paragraph(expiry, { muted: true }),
        callout(
          'What happens next',
          'Confirming your email does not sign you in. An administrator still has to ' +
            'approve your account before you can start working leads — you will be able ' +
            'to sign in once they have.',
        ),
        paragraph(
          'If you did not register for JMK Telecaller, you can ignore this email. ' +
            'Nobody can use this code without it, and no account becomes active until an ' +
            'administrator approves it.',
          { muted: true, size: 13 },
        ),
        signOff(),
      ].join('\n'),
    }),
    text: renderText([
      `Hello ${data.name},`,
      '',
      'Enter this code in the JMK Telecaller app to confirm this is your email address.',
      '',
      `Verification code: ${data.code}`,
      '',
      expiry,
      '',
      'Confirming your email does not sign you in. An administrator still has to approve',
      'your account before you can start working leads.',
      '',
      'If you did not register for JMK Telecaller, you can ignore this email.',
      '',
      'Warm regards,',
      'JMK Global Holdings',
    ]),
  };
}
