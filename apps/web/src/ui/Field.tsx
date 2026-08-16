import type { InputHTMLAttributes, Ref } from 'react';
import { useId } from 'react';

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  problem?: string | null;
  code?: boolean;
  ref?: Ref<HTMLInputElement>;
}

export function Field({
  label,
  hint,
  problem = null,
  code = false,
  className,
  ref,
  ...rest
}: FieldProps): React.JSX.Element {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const hasHint = hint !== undefined || problem !== null;

  const classes = ['field__input', code ? 'field__input--code' : '', className ?? '']
    .filter((one) => one !== '')
    .join(' ');

  return (
    <div className="field">
      <label className="field__label" htmlFor={inputId}>
        {label}
      </label>

      <input
        id={inputId}
        ref={ref}
        className={classes}
        aria-invalid={problem === null ? undefined : true}
        aria-describedby={hasHint ? hintId : undefined}
        {...rest}
      />

      {hasHint ? (
        <p className="field__hint" id={hintId}>
          {problem ?? hint}
        </p>
      ) : null}
    </div>
  );
}
