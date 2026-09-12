'use client';

import { useState } from 'react';
import { FormAlert, SubmitButton, TextField } from '@/components/forms/Fields';
import { ApiError, adminApi } from '@/lib/api';
import { validateEmail, validateRequired } from '@/lib/validation';
import { assetPath } from '@/lib/paths';

export function AdminLogin({ onSuccess }: { onSuccess: (email: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const nextErrors = {
      email: validateEmail(email) ?? undefined,
      password: validateRequired(password, 'Password') ?? undefined,
    };
    setErrors(nextErrors);
    if (nextErrors.email || nextErrors.password) return;

    setPending(true);
    try {
      const session = await adminApi.login(email.trim(), password);
      onSuccess(session.email);
    } catch (error) {
      setFormError(
        error instanceof ApiError && error.status === 401
          ? 'Incorrect email or password.'
          : error instanceof ApiError
            ? error.message
            : 'Sign in failed. Please try again.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="admin-login">
      <div className="admin-login__card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="admin-login__logo"
          src={assetPath('/images/brand/logo.png')}
          alt="JMK Global Holdings"
          width={508}
          height={160}
          decoding="async"
          fetchPriority="high"
        />

        <h1 className="admin-login__title">Admin sign in</h1>
        <p className="admin-login__lede">
          Restricted area. Enquiries and applications are only visible to authorised staff.
        </p>

        <form className="form" onSubmit={handleSubmit} noValidate>
          {formError ? <FormAlert variant="error">{formError}</FormAlert> : null}

          <TextField
            label="Email"
            name="adminEmail"
            type="email"
            value={email}
            onChange={setEmail}
            error={errors.email}
            required
            autoComplete="username"
          />
          <TextField
            label="Password"
            name="adminPassword"
            type="password"
            value={password}
            onChange={setPassword}
            error={errors.password}
            required
            autoComplete="current-password"
          />

          <SubmitButton pending={pending} pendingLabel="Signing in…">
            Sign in
          </SubmitButton>
        </form>
      </div>
    </div>
  );
}
