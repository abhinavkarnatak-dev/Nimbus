import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonTone = 'primary' | 'secondary' | 'quiet' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
  block?: boolean;
  large?: boolean;
  children: ReactNode;
}

export function Button({
  tone = 'secondary',
  block = false,
  large = false,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps): React.JSX.Element {
  const classes = [
    'button',
    `button--${tone}`,
    block ? 'button--block' : '',
    large ? 'button--large' : '',
    className ?? '',
  ]
    .filter((one) => one !== '')
    .join(' ');

  return (
    <button className={classes} type={type} {...rest}>
      {children}
    </button>
  );
}
