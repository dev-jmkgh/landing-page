/**
 * Email module.
 *
 * One layout (`layout/base`) wraps every message JMK sends; templates supply only the
 * content block. Adding a new notification means adding a template here, never another
 * copy of the header and footer.
 */

export { renderEmail, renderText, type EmailDocument } from './layout/base';
export {
  formatSubmissionTime,
  actionButton,
  callout,
  sectionHeading,
  metricGrid,
  dataTable,
  textTable,
  type CalloutTone,
  type MetricTile,
  type MetricTone,
  type DataColumn,
  type DataCell,
} from './layout/components';
export { BRAND } from './layout/brand';
export { EMAIL_LOGO_CID, EMAIL_LOGO_PNG } from './layout/logo';

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

export {
  employeeVerificationEmail,
  type EmployeeVerificationEmailData,
} from './templates/employeeVerification';

export {
  dailyTelecallingReportEmail,
  formatReportDay,
  TEAM_TABLE_LIMIT,
  type DailyReportEmailData,
  type DailyReportEmailLinks,
} from './templates/dailyTelecallingReport';
