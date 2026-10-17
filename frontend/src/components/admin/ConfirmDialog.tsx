'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { ButtonSpinner } from '@/components/admin/Loader';
import { FormAlert, TextAreaField, TextField } from '@/components/forms/Fields';
import { Dialog } from '@/components/ui/Dialog';

/**
 * The admin website's one popup for "Are you sure?" and "Type a reason".
 *
 * Never the browser's `confirm()` / `prompt()`. A browser told to stop a page's dialogs — or
 * an embedded view — makes them return "cancel" without showing anything, so the button
 * that asked appears to do nothing. They cannot be styled, cannot check what was typed
 * before closing, and wrap long text badly.
 *
 * Two ways in, one look:
 * - `useDialogs()` — `await confirm({...})` and `await prompt({...})`, in place of the
 *   browser's, for actions that run on the page once answered. `AdminShell` provides it.
 * - `<ConfirmDialog>` — for actions that run INSIDE the dialog, which stays open showing
 *   progress and keeps a failure in view (approving payroll, deciding a correction).
 */

/**
 * A close handler whose identity never changes.
 *
 * `Dialog` re-runs its open effect — which moves focus to the panel — whenever `onClose`
 * changes identity. A dialog re-renders as it is used (a select changes, a button goes
 * busy), so an inline handler would pull focus out of the control being used on every
 * change. The latest handler lives in a ref and `Dialog` gets one stable function. The same
 * fix as `useStableClose` in the people screens.
 */
export function useStableClose(onClose: () => void): () => void {
  const ref = useRef(onClose);
  useEffect(() => {
    ref.current = onClose;
  });
  return useCallback(() => ref.current(), []);
}

/**
 * Puts focus back on `element` when the calling component unmounts, if it is still in
 * the document. The element is fixed at the first render: it is "whoever opened me".
 *
 * Only when focus has nowhere better to be. If the screen moved focus on purpose as the
 * dialog closed — to a heading, because the button that opened it is about to disappear
 * (an approved run has no Approve button) — that choice stands.
 */
export function useRestoreFocus(element: HTMLElement | null) {
  const [target] = useState(element);
  useEffect(
    () => () => {
      window.setTimeout(() => {
        if (!target || !target.isConnected) return;
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected) return;
        target.focus();
      }, 0);
    },
    [target],
  );
}

/**
 * "Are you sure?", for an action the parent runs while the dialog stays open.
 *
 * On the shared `Dialog`, which traps Tab, closes on Escape and moves focus in on open.
 * What the shell does not do is give focus back when the dialog is closed by the PARENT
 * (Cancel, or the action finishing) rather than by its own close button, so this keeps
 * the element that opened it and returns focus there on unmount — if that element still
 * exists. After a delete it may not; the screen that remains moves focus itself.
 *
 * The opener is read during the first render, before the shell's effect moves focus into
 * the dialog: by the time any effect here ran, `activeElement` would be the dialog.
 *
 * A form, so Enter in a typed answer confirms, as it did in the browser's prompt.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busyLabel,
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  error = null,
  dismissOnBackdrop = true,
  onConfirm,
  onCancel,
}: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  /** The confirm button while `busy`, e.g. "Approving…". Defaults to `confirmLabel`. */
  busyLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive: removing, switching off, rejecting. */
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  /** False when something typed would be lost to a stray click beside the panel. */
  dismissOnBackdrop?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  );

  // Restore focus when this unmounts, however it was closed.
  useRestoreFocus(opener);

  const close = useStableClose(() => {
    if (!busy) onCancel();
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy) onConfirm();
  };

  return (
    <Dialog
      open
      onClose={close}
      title={title}
      className="tc-confirm-dialog"
      dismissOnBackdrop={dismissOnBackdrop && !busy}
    >
      <form className="dialog__body" onSubmit={submit} noValidate>
        <h2 className="dialog__title tc-confirm-dialog__title">{title}</h2>
        {children ? <div className="tc-confirm-dialog__text">{children}</div> : null}

        {error ? (
          <div style={{ marginTop: 'var(--space-4)' }}>
            <FormAlert variant="error">{error}</FormAlert>
          </div>
        ) : null}

        <div className="tc-confirm-dialog__actions">
          <button type="button" className="btn btn--outline" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="submit"
            className={danger ? 'btn btn--primary btn--danger' : 'btn btn--primary'}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {busy ? <ButtonSpinner /> : null}
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* confirm() and prompt()                                                      */
/* -------------------------------------------------------------------------- */

export type ConfirmOptions = {
  title: string;
  /** Plain text, where a blank line starts a new paragraph — or any content. */
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive: removing, switching off, rejecting. */
  danger?: boolean;
};

export type PromptOptions = ConfirmOptions & {
  /** The box's label. */
  label: string;
  initialValue?: string;
  placeholder?: string;
  hint?: string;
  /** A few lines instead of one — for a reason or a note. */
  multiline?: boolean;
  type?: 'text' | 'tel';
  maxLength?: number;
  autoComplete?: string;
  /**
   * Checks the answer before the dialog closes. Return a message to keep it open with the
   * message under the box, so a mistyped number is corrected in place rather than lost.
   */
  validate?: (value: string) => string | null;
};

export type Dialogs = {
  /** True when confirmed; false when cancelled, dismissed or replaced. */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** What was typed (possibly empty) when confirmed; null when cancelled. */
  prompt: (options: PromptOptions) => Promise<string | null>;
};

type Question =
  | { kind: 'confirm'; key: number; options: ConfirmOptions; settle: (answer: boolean) => void }
  | { kind: 'prompt'; key: number; options: PromptOptions; settle: (answer: string | null) => void };

function cancelQuestion(question: Question) {
  if (question.kind === 'confirm') question.settle(false);
  else question.settle(null);
}

const DialogsContext = createContext<Dialogs | null>(null);

/** The browser's confirm() and prompt(), as the admin website's own dialog. */
export function useDialogs(): Dialogs {
  const dialogs = useContext(DialogsContext);
  if (!dialogs) throw new Error('useDialogs() needs a <DialogProvider> above it; AdminShell renders one.');
  return dialogs;
}

/** Shows one question at a time for everything below it. Rendered by `AdminShell`. */
export function DialogProvider({ children }: { children: ReactNode }) {
  const [question, setQuestion] = useState<Question | null>(null);
  // The open question, readable by the callbacks without making them change identity.
  const current = useRef<Question | null>(null);
  const counter = useRef(0);

  const ask = useCallback((next: Question) => {
    // A second question answers the first as cancelled rather than leaving it waiting.
    if (current.current) cancelQuestion(current.current);
    current.current = next;
    setQuestion(next);
  }, []);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((settle) => {
        counter.current += 1;
        ask({ kind: 'confirm', key: counter.current, options, settle });
      }),
    [ask],
  );

  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((settle) => {
        counter.current += 1;
        ask({ kind: 'prompt', key: counter.current, options, settle });
      }),
    [ask],
  );

  const answer = useCallback((confirmed: boolean, value = '') => {
    const open = current.current;
    if (!open) return;
    current.current = null;
    setQuestion(null);
    if (!confirmed) cancelQuestion(open);
    else if (open.kind === 'confirm') open.settle(true);
    else open.settle(value);
  }, []);

  // Gone with a question open (signed out, say): whoever asked hears "cancel".
  useEffect(
    () => () => {
      if (current.current) cancelQuestion(current.current);
      current.current = null;
    },
    [],
  );

  const dialogs = useMemo(() => ({ confirm, prompt }), [confirm, prompt]);

  return (
    <DialogsContext.Provider value={dialogs}>
      {children}
      {question ? <QuestionDialog key={question.key} question={question} onAnswer={answer} /> : null}
    </DialogsContext.Provider>
  );
}

function QuestionDialog({
  question,
  onAnswer,
}: {
  question: Question;
  onAnswer: (confirmed: boolean, value?: string) => void;
}) {
  const { options } = question;
  const asks = question.kind === 'prompt' ? question.options : null;
  const [value, setValue] = useState(asks?.initialValue ?? '');
  const [error, setError] = useState<string | undefined>(undefined);
  const fieldRef = useRef<HTMLDivElement | null>(null);

  const focusBox = (select: boolean) => {
    const box = fieldRef.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
    box?.focus();
    if (select) box?.select();
  };

  // Straight into the box with its text selected, as the browser's prompt did. This runs
  // after the shell has focused the panel: a child's effects run before its parent's.
  useEffect(() => {
    if (asks) focusBox(true);
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirm = () => {
    if (!asks) return onAnswer(true);
    const problem = asks.validate?.(value) ?? null;
    if (problem) {
      setError(problem);
      focusBox(false);
      return;
    }
    onAnswer(true, value);
  };

  const change = (next: string) => {
    setValue(next);
    if (error) setError(undefined);
  };

  return (
    <ConfirmDialog
      title={options.title}
      confirmLabel={options.confirmLabel ?? (asks ? 'OK' : 'Confirm')}
      cancelLabel={options.cancelLabel}
      danger={options.danger}
      dismissOnBackdrop={!asks}
      onConfirm={confirm}
      onCancel={() => onAnswer(false)}
    >
      <Message message={options.message} />
      {asks ? (
        <div ref={fieldRef} className="tc-confirm-dialog__field">
          {asks.multiline ? (
            <TextAreaField
              label={asks.label}
              name="answer"
              rows={3}
              value={value}
              onChange={change}
              hint={asks.hint}
              error={error}
              placeholder={asks.placeholder}
              maxLength={asks.maxLength}
            />
          ) : (
            <TextField
              label={asks.label}
              name="answer"
              type={asks.type}
              value={value}
              onChange={change}
              hint={asks.hint}
              error={error}
              placeholder={asks.placeholder}
              maxLength={asks.maxLength}
              autoComplete={asks.autoComplete ?? 'off'}
            />
          )}
        </div>
      ) : null}
    </ConfirmDialog>
  );
}

/** A string's blank lines become paragraphs; anything else renders as given. */
function Message({ message }: { message: ReactNode }) {
  if (message === undefined || message === null || message === '') return null;
  if (typeof message !== 'string') return <>{message}</>;
  return (
    <>
      {message.split(/\n\s*\n/).map((paragraph, index) => (
        <p key={index} className="dialog__text">
          {paragraph}
        </p>
      ))}
    </>
  );
}
