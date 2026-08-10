'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  api,
  type EmailStatus,
  API_NOT_CONFIGURED_MESSAGE,
  isApiConfigured,
} from '@/lib/api';
import { EXPERIENCE_LEVELS, FIELD_LIMITS, RESUME_UPLOAD } from '@/lib/constants';
import { openPositions } from '@/lib/content/careers';
import {
  validateEmail,
  validateName,
  validateOptionalUrl,
  validatePhone,
  validateResume,
  validateSelection,
} from '@/lib/validation';
import {
  FileField,
  FormAlert,
  HoneypotField,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
} from '@/components/forms/Fields';
import {
  Recaptcha,
  isRecaptchaConfigured,
  type RecaptchaHandle,
} from '@/components/forms/Recaptcha';
import { Icon } from '@/components/ui/Icon';

type FormState = {
  fullName: string;
  email: string;
  phone: string;
  position: string;
  message: string;
  experience: string;
  location: string;
  linkedinUrl: string;
  portfolioUrl: string;
  website: string;
};

const EMPTY: FormState = {
  fullName: '',
  email: '',
  phone: '',
  position: '',
  message: '',
  experience: '',
  location: '',
  linkedinUrl: '',
  portfolioUrl: '',
  website: '',
};

type Errors = Partial<Record<keyof FormState | 'resume', string>>;

function validateAll(values: FormState, resume: File | null): Errors {
  const errors: Errors = {};

  const checks: [keyof FormState | 'resume', string | null][] = [
    ['fullName', validateName(values.fullName)],
    ['email', validateEmail(values.email)],
    ['phone', validatePhone(values.phone)],
    ['position', validateSelection(values.position, 'the position you are applying for')],
    ['resume', validateResume(resume, true)],
    ['linkedinUrl', validateOptionalUrl(values.linkedinUrl, 'LinkedIn')],
    ['portfolioUrl', validateOptionalUrl(values.portfolioUrl, 'portfolio')],
  ];

  for (const [field, message] of checks) {
    if (message) errors[field] = message;
  }

  if (values.message.trim().length > FIELD_LIMITS.message.max) {
    errors.message = `Cover letter must be ${FIELD_LIMITS.message.max} characters or fewer.`;
  }

  return errors;
}

export function ApplicationForm() {
  const [values, setValues] = useState<FormState>(EMPTY);
  const [resume, setResume] = useState<File | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [formError, setFormError] = useState<string | null>(null);
  /** Kept for the success panel, which greets the applicant after the form is cleared. */
  const [submitted, setSubmitted] = useState<{
    name: string;
    position: string;
    emailStatus: EmailStatus | null;
  } | null>(null);

  const renderedAt = useRef<number>(Date.now());
  const abortRef = useRef<AbortController | null>(null);

  /** Submit stays hidden until the reCAPTCHA checkbox is solved. */
  const [recaptchaToken, setRecaptchaToken] = useState<string | null>(null);
  const [recaptchaBlocked, setRecaptchaBlocked] = useState(false);
  const recaptchaRef = useRef<RecaptchaHandle | null>(null);

  const verificationRequired = isRecaptchaConfigured && !recaptchaBlocked;
  const canSubmit = !verificationRequired || Boolean(recaptchaToken);

  useEffect(() => () => abortRef.current?.abort(), []);

  const setField = (field: keyof FormState) => (value: string) => {
    setValues((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
  };

  function handleResumeChange(file: File | null) {
    setResume(file);
    setErrors((previous) => ({ ...previous, resume: validateResume(file, true) ?? undefined }));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A second submit while the first is in flight would create a duplicate record.
    if (pending) return;

    setFormError(null);

    const nextErrors = validateAll(values, resume);
    setErrors(nextErrors);

    if (Object.keys(nextErrors).length > 0) {
      setStatus('error');
      setFormError('Please correct the highlighted fields and try again.');
      return;
    }

    if (verificationRequired && !recaptchaToken) {
      setStatus('error');
      setFormError('Please complete the "I am not a robot" verification.');
      return;
    }

    const formData = new FormData();
    formData.append('fullName', values.fullName.trim());
    formData.append('email', values.email.trim());
    formData.append('phone', values.phone.trim());
    formData.append('position', values.position);
    formData.append('message', values.message.trim());
    formData.append('experience', values.experience);
    formData.append('location', values.location.trim());
    formData.append('linkedinUrl', values.linkedinUrl.trim());
    formData.append('portfolioUrl', values.portfolioUrl.trim());
    formData.append('website', values.website);
    formData.append('renderedAt', String(renderedAt.current));
    if (recaptchaToken) formData.append('recaptchaToken', recaptchaToken);
    if (resume) formData.append('resume', resume);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPending(true);
    setStatus('idle');

    try {
      const result = await api.submitApplication(formData, controller.signal);
      setSubmitted({
        name: values.fullName.trim(),
        position: values.position,
        emailStatus: result?.emailStatus ?? null,
      });
      setStatus('success');
      setValues(EMPTY);
      setResume(null);
      renderedAt.current = Date.now();
      // A v2 token is single-use, so re-arm the widget for any further submission.
      recaptchaRef.current?.reset();
      setRecaptchaToken(null);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;

      setStatus('error');
      if (error instanceof ApiError) {
        const fieldErrors = error.fieldErrors as Errors;
        if (Object.keys(fieldErrors).length > 0) setErrors(fieldErrors);
        setFormError(error.message);
      } else {
        setFormError('Something went wrong. Please try again in a moment.');
      }
      // The token was consumed by the rejected attempt; it must be solved again.
      recaptchaRef.current?.reset();
      setRecaptchaToken(null);
    } finally {
      setPending(false);
    }
  }

  if (status === 'success' && submitted) {
    return (
      <div className="apply-success">
        <span className="apply-success__mark" aria-hidden="true">
          <Icon name="check" size={26} />
        </span>
        <h3 className="apply-success__title">Application Received</h3>
        <p className="apply-success__lead">Thank you, {submitted.name}.</p>
        <p className="apply-success__body">
          Your application for <strong>{submitted.position}</strong> has been received
          successfully. We appreciate your interest in JMK Global Holdings.
        </p>
        {/* Say so plainly when the confirmation email could not be delivered. The
            application itself is already stored, so this is a note, not an error. */}
        {submitted.emailStatus === 'failed' || submitted.emailStatus === 'partial' ? (
          <p className="apply-success__note">
            We could not send your confirmation email, but your application and resume are
            safely stored and our team can see them.
          </p>
        ) : null}
        <div className="apply-success__actions">
          <a className="btn btn--primary" href="#roles">
            Back to Careers
          </a>
          <button
            type="button"
            className="btn btn--outline"
            onClick={() => {
              setStatus('idle');
              setSubmitted(null);
            }}
          >
            Submit another application
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="form" onSubmit={handleSubmit} noValidate encType="multipart/form-data">
      {/* Front-end-only deployment: say so before anyone fills the form in. */}
      {!isApiConfigured() ? (
        <FormAlert variant="info">{API_NOT_CONFIGURED_MESSAGE}</FormAlert>
      ) : null}

      {formError ? <FormAlert variant="error">{formError}</FormAlert> : null}

      <div className="form-row form-row--2">
        <TextField
          label="Full Name"
          name="fullName"
          value={values.fullName}
          onChange={setField('fullName')}
          error={errors.fullName}
          required
          autoComplete="name"
          maxLength={FIELD_LIMITS.name.max}
          placeholder="Your full name"
        />
        <TextField
          label="Email"
          name="email"
          type="email"
          value={values.email}
          onChange={setField('email')}
          error={errors.email}
          required
          autoComplete="email"
          maxLength={FIELD_LIMITS.email.max}
          placeholder="you@example.com"
        />
      </div>

      <div className="form-row form-row--2">
        <TextField
          label="Phone"
          name="phone"
          type="tel"
          value={values.phone}
          onChange={setField('phone')}
          error={errors.phone}
          required
          autoComplete="tel"
          maxLength={FIELD_LIMITS.phone.max}
          placeholder="+91 00000 00000"
        />
        <SelectField
          label="Position Applied For"
          name="position"
          value={values.position}
          options={openPositions}
          onChange={setField('position')}
          error={errors.position}
          required
          placeholder="Select a position"
        />
      </div>

      <div className="form-row form-row--2">
        <SelectField
          label="Years of Experience"
          name="experience"
          value={values.experience}
          options={[...EXPERIENCE_LEVELS]}
          onChange={setField('experience')}
          error={errors.experience}
          placeholder="Select (optional)"
        />
        <TextField
          label="Current Location"
          name="location"
          value={values.location}
          onChange={setField('location')}
          error={errors.location}
          autoComplete="address-level2"
          maxLength={120}
          placeholder="City (optional)"
        />
      </div>

      <div className="form-row form-row--2">
        <TextField
          label="LinkedIn URL"
          name="linkedinUrl"
          type="url"
          value={values.linkedinUrl}
          onChange={setField('linkedinUrl')}
          error={errors.linkedinUrl}
          maxLength={255}
          placeholder="https://www.linkedin.com/in/… (optional)"
        />
        <TextField
          label="Portfolio URL"
          name="portfolioUrl"
          type="url"
          value={values.portfolioUrl}
          onChange={setField('portfolioUrl')}
          error={errors.portfolioUrl}
          maxLength={255}
          placeholder="https://… (optional)"
        />
      </div>

      <TextAreaField
        label="Cover Letter"
        name="message"
        value={values.message}
        onChange={setField('message')}
        error={errors.message}
        rows={4}
        maxLength={FIELD_LIMITS.message.max}
        placeholder="Tell us why you are a good fit for this role."
      />

      <FileField
        label="Resume / CV"
        name="resume"
        file={resume}
        accept={RESUME_UPLOAD.accept}
        onChange={handleResumeChange}
        error={errors.resume}
        required
        disabled={pending}
        uploading={pending}
        hint={`${RESUME_UPLOAD.acceptedExtensions.join(', ')} — up to ${RESUME_UPLOAD.maxSizeLabel}`}
      />

      <HoneypotField value={values.website} onChange={setField('website')} />

      <Recaptcha
        handleRef={recaptchaRef}
        onChange={setRecaptchaToken}
        onUnavailable={() => setRecaptchaBlocked(true)}
      />

      {canSubmit ? (
        <SubmitButton pending={pending} pendingLabel="Submitting Application…">
          Submit Application
        </SubmitButton>
      ) : (
        <p className="submit-gate">
          <Icon name="shield" size={18} />
          <span>
            Complete the &ldquo;I&rsquo;m not a robot&rdquo; check above and the submit button
            will appear.
          </span>
        </p>
      )}

      <p className="field__hint">
        Your details and resume are used solely to assess your application. See our{' '}
        <a href="/privacy-policy/" style={{ textDecoration: 'underline' }}>
          Privacy Policy
        </a>
        .
      </p>
    </form>
  );
}
