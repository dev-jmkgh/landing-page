'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { FIELD_LIMITS, RESUME_UPLOAD, SUCCESS_MESSAGES } from '@/lib/constants';
import { openPositions } from '@/lib/content/careers';
import {
  validateEmail,
  validateName,
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

type FormState = {
  fullName: string;
  email: string;
  phone: string;
  position: string;
  message: string;
  website: string;
};

const EMPTY: FormState = {
  fullName: '',
  email: '',
  phone: '',
  position: '',
  message: '',
  website: '',
};

type Errors = Partial<Record<keyof FormState | 'resume', string>>;

function validateAll(values: FormState, resume: File | null): Errors {
  const errors: Errors = {};
  const fullName = validateName(values.fullName);
  const email = validateEmail(values.email);
  const phone = validatePhone(values.phone);
  const position = validateSelection(values.position, 'the position you are applying for');
  const resumeError = validateResume(resume, true);

  if (fullName) errors.fullName = fullName;
  if (email) errors.email = email;
  if (phone) errors.phone = phone;
  if (position) errors.position = position;
  if (resumeError) errors.resume = resumeError;
  if (values.message.trim().length > FIELD_LIMITS.message.max)
    errors.message = `Message must be ${FIELD_LIMITS.message.max} characters or fewer.`;

  return errors;
}

export function ApplicationForm() {
  const [values, setValues] = useState<FormState>(EMPTY);
  const [resume, setResume] = useState<File | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [formError, setFormError] = useState<string | null>(null);

  const renderedAt = useRef<number>(Date.now());
  const abortRef = useRef<AbortController | null>(null);

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
    setFormError(null);

    const nextErrors = validateAll(values, resume);
    setErrors(nextErrors);

    if (Object.keys(nextErrors).length > 0) {
      setStatus('error');
      setFormError('Please correct the highlighted fields and try again.');
      return;
    }

    const formData = new FormData();
    formData.append('fullName', values.fullName.trim());
    formData.append('email', values.email.trim());
    formData.append('phone', values.phone.trim());
    formData.append('position', values.position);
    formData.append('message', values.message.trim());
    formData.append('website', values.website);
    formData.append('renderedAt', String(renderedAt.current));
    if (resume) formData.append('resume', resume);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPending(true);
    setStatus('idle');

    try {
      await api.submitApplication(formData, controller.signal);
      setStatus('success');
      setValues(EMPTY);
      setResume(null);
      renderedAt.current = Date.now();
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
    } finally {
      setPending(false);
    }
  }

  if (status === 'success') {
    return (
      <div className="form">
        <FormAlert variant="success">
          <strong>{SUCCESS_MESSAGES.application}</strong>
        </FormAlert>
        <button type="button" className="btn btn--outline" onClick={() => setStatus('idle')}>
          Submit another application
        </button>
      </div>
    );
  }

  return (
    <form className="form" onSubmit={handleSubmit} noValidate encType="multipart/form-data">
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

      <TextAreaField
        label="Message"
        name="message"
        value={values.message}
        onChange={setField('message')}
        error={errors.message}
        rows={4}
        maxLength={FIELD_LIMITS.message.max}
        placeholder="Briefly tell us about your experience (optional)."
      />

      <FileField
        label="Resume"
        name="resume"
        file={resume}
        accept={RESUME_UPLOAD.accept}
        onChange={handleResumeChange}
        error={errors.resume}
        required
        hint={`${RESUME_UPLOAD.acceptedExtensions.join(', ')} — up to ${RESUME_UPLOAD.maxSizeLabel}`}
      />

      <HoneypotField value={values.website} onChange={setField('website')} />

      <SubmitButton pending={pending} pendingLabel="Sending application…">
        Submit Application
      </SubmitButton>

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
