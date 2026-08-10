'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError, api, type EnquiryPayload } from '@/lib/api';
import { INTEREST_OPTIONS, FIELD_LIMITS, SUCCESS_MESSAGES } from '@/lib/constants';
import {
  validateCompany,
  validateEmail,
  validateMessage,
  validateName,
  validatePhone,
  validateSelection,
} from '@/lib/validation';
import {
  FormAlert,
  HoneypotField,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
} from '@/components/forms/Fields';

type EnquiryFormProps = {
  source: EnquiryPayload['source'];
  defaultInterest?: string;
  submitLabel?: string;
  onSuccess?: () => void;
};

type FormState = {
  name: string;
  email: string;
  phone: string;
  company: string;
  interestedIn: string;
  message: string;
  website: string;
};

const EMPTY: FormState = {
  name: '',
  email: '',
  phone: '',
  company: '',
  interestedIn: '',
  message: '',
  website: '',
};

type Errors = Partial<Record<keyof FormState, string>>;

function validateAll(values: FormState): Errors {
  const errors: Errors = {};
  const name = validateName(values.name);
  const email = validateEmail(values.email);
  const phone = validatePhone(values.phone);
  const company = validateCompany(values.company);
  const interest = validateSelection(values.interestedIn, 'what you are interested in');
  const message = validateMessage(values.message);

  if (name) errors.name = name;
  if (email) errors.email = email;
  if (phone) errors.phone = phone;
  if (company) errors.company = company;
  if (interest) errors.interestedIn = interest;
  if (message) errors.message = message;

  return errors;
}

export function EnquiryForm({
  source,
  defaultInterest,
  submitLabel = 'Submit Enquiry',
  onSuccess,
}: EnquiryFormProps) {
  const [values, setValues] = useState<FormState>({
    ...EMPTY,
    interestedIn: defaultInterest ?? '',
  });
  const [errors, setErrors] = useState<Errors>({});
  const [touched, setTouched] = useState<Partial<Record<keyof FormState, boolean>>>({});
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [formError, setFormError] = useState<string | null>(null);

  const renderedAt = useRef<number>(Date.now());
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const setField = (field: keyof FormState) => (value: string) => {
    setValues((previous) => ({ ...previous, [field]: value }));
    if (touched[field]) {
      setErrors((previous) => ({ ...previous, [field]: validateAll({ ...values, [field]: value })[field] }));
    }
  };

  const blurField = (field: keyof FormState) => () => {
    setTouched((previous) => ({ ...previous, [field]: true }));
    setErrors((previous) => ({ ...previous, [field]: validateAll(values)[field] }));
  };

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const nextErrors = validateAll(values);
    setErrors(nextErrors);
    setTouched({
      name: true,
      email: true,
      phone: true,
      company: true,
      interestedIn: true,
      message: true,
    });

    if (Object.keys(nextErrors).length > 0) {
      setStatus('error');
      setFormError('Please correct the highlighted fields and try again.');
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPending(true);
    setStatus('idle');

    try {
      await api.submitEnquiry(
        {
          name: values.name.trim(),
          email: values.email.trim(),
          phone: values.phone.trim(),
          company: values.company.trim() || undefined,
          interestedIn: values.interestedIn,
          message: values.message.trim(),
          source,
          website: values.website,
          renderedAt: renderedAt.current,
        },
        controller.signal,
      );

      setStatus('success');
      setValues({ ...EMPTY, interestedIn: defaultInterest ?? '' });
      setTouched({});
      renderedAt.current = Date.now();
      onSuccess?.();
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
          <strong>{SUCCESS_MESSAGES.enquiry}</strong>
        </FormAlert>
        <button type="button" className="btn btn--outline" onClick={() => setStatus('idle')}>
          Send another enquiry
        </button>
      </div>
    );
  }

  return (
    <form className="form" onSubmit={handleSubmit} noValidate>
      {formError ? <FormAlert variant="error">{formError}</FormAlert> : null}

      <div className="form-row form-row--2">
        <TextField
          label="Name"
          name="name"
          value={values.name}
          onChange={setField('name')}
          onBlur={blurField('name')}
          error={errors.name}
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
          onBlur={blurField('email')}
          error={errors.email}
          required
          autoComplete="email"
          maxLength={FIELD_LIMITS.email.max}
          placeholder="you@company.com"
        />
      </div>

      <div className="form-row form-row--2">
        <TextField
          label="Phone"
          name="phone"
          type="tel"
          value={values.phone}
          onChange={setField('phone')}
          onBlur={blurField('phone')}
          error={errors.phone}
          required
          autoComplete="tel"
          maxLength={FIELD_LIMITS.phone.max}
          placeholder="+91 00000 00000"
        />
        <TextField
          label="Company / Organization"
          name="company"
          value={values.company}
          onChange={setField('company')}
          onBlur={blurField('company')}
          error={errors.company}
          autoComplete="organization"
          maxLength={FIELD_LIMITS.company.max}
          placeholder="Optional"
        />
      </div>

      <SelectField
        label="Interested In"
        name="interestedIn"
        value={values.interestedIn}
        options={INTEREST_OPTIONS}
        onChange={setField('interestedIn')}
        onBlur={blurField('interestedIn')}
        error={errors.interestedIn}
        required
        placeholder="Select a business or service"
      />

      <TextAreaField
        label="Message"
        name="message"
        value={values.message}
        onChange={setField('message')}
        onBlur={blurField('message')}
        error={errors.message}
        required
        rows={5}
        maxLength={FIELD_LIMITS.message.max}
        placeholder="Tell us what you need and we will route your enquiry to the right team."
        hint={`${values.message.trim().length}/${FIELD_LIMITS.message.max} characters`}
      />

      <HoneypotField value={values.website} onChange={setField('website')} />

      <SubmitButton pending={pending}>{submitLabel}</SubmitButton>

      <p className="field__hint">
        By submitting this form you agree to be contacted by JMK Global Holdings regarding your
        enquiry.
      </p>
    </form>
  );
}
