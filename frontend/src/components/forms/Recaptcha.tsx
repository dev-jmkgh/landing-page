'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';

/**
 * Google reCAPTCHA v2 ("I'm not a robot") checkbox.
 *
 * The widget is rendered explicitly so the component controls exactly when it appears
 * and can reset it after a successful submission. The API script is loaded once per
 * page and shared by every widget on it.
 *
 * When `NEXT_PUBLIC_RECAPTCHA_SITE_KEY` is not configured, `isRecaptchaConfigured` is
 * false and forms skip the check entirely — local development works without keys, and
 * the backend independently skips verification when it has no secret.
 */

const SITE_KEY = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY ?? '';
const SCRIPT_ID = 'recaptcha-api';
const SCRIPT_SRC = 'https://www.google.com/recaptcha/api.js?render=explicit';

export const isRecaptchaConfigured = SITE_KEY.trim().length > 0;

type GreCaptcha = {
  render: (
    container: HTMLElement,
    parameters: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
      theme?: 'light' | 'dark';
      size?: 'normal' | 'compact';
    },
  ) => number;
  reset: (widgetId?: number) => void;
};

declare global {
  interface Window {
    grecaptcha?: GreCaptcha & { ready?: (callback: () => void) => void };
  }
}

let scriptPromise: Promise<void> | null = null;

/** Loads the reCAPTCHA script once and resolves when the API is usable. */
function loadRecaptchaScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.grecaptcha?.render) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;

    const waitForApi = () => {
      const started = Date.now();
      const poll = window.setInterval(() => {
        if (window.grecaptcha?.render) {
          window.clearInterval(poll);
          resolve();
        } else if (Date.now() - started > 15_000) {
          window.clearInterval(poll);
          reject(new Error('reCAPTCHA API did not become available'));
        }
      }, 100);
    };

    if (existing) {
      waitForApi();
      return;
    }

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = waitForApi;
    script.onerror = () => reject(new Error('Could not load reCAPTCHA'));
    document.head.appendChild(script);
  }).catch((error) => {
    // Allow a later mount to retry rather than caching the failure forever.
    scriptPromise = null;
    throw error;
  });

  return scriptPromise;
}

export type RecaptchaHandle = {
  /** Clears the solved state and re-arms the widget, e.g. after a submission. */
  reset: () => void;
};

type RecaptchaProps = {
  /** Receives the token when solved, and null when it expires or errors. */
  onChange: (token: string | null) => void;
  /** Called once the widget cannot be used at all, so the form can decide what to do. */
  onUnavailable?: () => void;
  /** Exposes a reset handle to the parent form. */
  handleRef?: React.MutableRefObject<RecaptchaHandle | null>;
};

export function Recaptcha({ onChange, onUnavailable, handleRef }: RecaptchaProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  const onUnavailableRef = useRef(onUnavailable);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const instanceId = useId();

  // Keep the latest callbacks without re-running the render effect, which would
  // otherwise tear down and rebuild the widget on every parent state change.
  useEffect(() => {
    onChangeRef.current = onChange;
    onUnavailableRef.current = onUnavailable;
  }, [onChange, onUnavailable]);

  const reset = useCallback(() => {
    if (widgetIdRef.current !== null && window.grecaptcha?.reset) {
      window.grecaptcha.reset(widgetIdRef.current);
    }
    onChangeRef.current(null);
  }, []);

  useEffect(() => {
    if (handleRef) handleRef.current = { reset };
  }, [handleRef, reset]);

  useEffect(() => {
    if (!isRecaptchaConfigured) return;

    let cancelled = false;

    loadRecaptchaScript()
      .then(() => {
        if (cancelled || !containerRef.current || widgetIdRef.current !== null) return;
        if (!window.grecaptcha?.render) throw new Error('reCAPTCHA API unavailable');

        widgetIdRef.current = window.grecaptcha.render(containerRef.current, {
          sitekey: SITE_KEY,
          callback: (token: string) => onChangeRef.current(token),
          'expired-callback': () => onChangeRef.current(null),
          'error-callback': () => onChangeRef.current(null),
          theme: 'light',
          size: 'normal',
        });

        setStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('failed');
        onUnavailableRef.current?.();
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!isRecaptchaConfigured) return null;

  return (
    <div className="recaptcha-field">
      <div ref={containerRef} id={`recaptcha-${instanceId}`} />

      {status === 'loading' ? (
        <p className="recaptcha-field__status" role="status">
          Loading verification…
        </p>
      ) : null}

      {status === 'failed' ? (
        <p className="recaptcha-field__status recaptcha-field__status--error" role="alert">
          The verification could not be loaded. Check your connection and refresh the page, or
          email us directly at info@jmkglobalholdings.com.
        </p>
      ) : null}
    </div>
  );
}
