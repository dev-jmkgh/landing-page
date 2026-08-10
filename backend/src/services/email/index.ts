/**
 * Email module.
 *
 * One layout (`layout/base`) wraps every message JMK sends; templates supply only the
 * content block. Adding a new notification means adding a template here, never another
 * copy of the header and footer.
 */

export { renderEmail, renderText, type EmailDocument } from './layout/base';
export { formatSubmissionTime } from './layout/components';
export { BRAND } from './layout/brand';

export {
  enquiryAdminEmail,
  enquiryConfirmationEmail,
  type EnquiryEmailData,
} from './templates/enquiry';

export {
  jobApplicationAdminEmail,
  jobApplicationConfirmationEmail,
  type JobApplicationEmailData,
} from './templates/jobApplication';
