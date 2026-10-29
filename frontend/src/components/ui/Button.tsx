'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'tonal'
  | 'ghost'
  | 'subtle'
  | 'outline'
  | 'danger'
  | 'link';

type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
  loading?: boolean;
  fullWidth?: boolean;
}

const base =
  'relative inline-flex items-center justify-center gap-1.5 font-emphasis whitespace-nowrap rounded-md transition-[background-color,box-shadow,border-color,color] duration-150 ease-out select-none disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-focus-brand';

const sizes: Record<ButtonSize, string> = {
  xs: 'h-7 px-2.5 text-label gap-1',
  sm: 'h-8 px-3 text-caption',
  md: 'h-9 px-3.5 text-caption',
  lg: 'h-10 px-4 text-small',
};

const variants: Record<ButtonVariant, string> = {
  primary:
    'bg-brand text-text-inverse hover:bg-brand-hover active:bg-brand-active shadow-linear-sm',
  secondary:
    'bg-surface-1 text-text-primary border border-stroke-strong hover:border-stroke-control hover:bg-surface-2 active:bg-surface-3',
  // Recognisable but quieter than primary: brand container, brand text.
  tonal:
    'bg-brand-container text-brand-on-container hover:bg-brand-container-hover active:bg-brand-container-hover',
  ghost:
    'bg-transparent text-text-secondary hover:bg-surface-2 hover:text-text-primary active:bg-surface-3',
  subtle:
    'bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary',
  outline:
    'bg-transparent text-text-primary border border-stroke-strong hover:border-stroke-control hover:bg-surface-2',
  danger:
    'bg-danger text-text-inverse hover:brightness-90 active:brightness-75 shadow-linear-sm',
  link:
    'bg-transparent text-brand hover:text-brand-hover underline-offset-4 hover:underline px-1 h-auto',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'secondary',
      size = 'md',
      leadingIcon,
      trailingIcon,
      loading,
      disabled,
      fullWidth,
      children,
      type = 'button',
      ...props
    },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={cn(
          base,
          sizes[size],
          variants[variant],
          fullWidth && 'w-full',
          className,
        )}
        {...props}
      >
        {loading ? (
          // Layout-stable: the label keeps its space (invisible) and the spinner
          // sits on top, so a loading button never changes width.
          <>
            <span className="absolute inset-0 flex items-center justify-center" aria-hidden>
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            </span>
            <span className="invisible inline-flex items-center gap-[inherit]">
              {leadingIcon}
              {children}
              {trailingIcon}
            </span>
          </>
        ) : (
          <>
            {leadingIcon}
            {children}
            {trailingIcon}
          </>
        )}
      </button>
    );
  },
);

Button.displayName = 'Button';

/** Icon-only button with square aspect ratio. */
export interface IconButtonProps extends ButtonProps {
  'aria-label': string;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, size = 'md', children, ...props }, ref) => {
    const square: Record<ButtonSize, string> = {
      xs: 'h-7 w-7 p-0',
      sm: 'h-8 w-8 p-0',
      md: 'h-9 w-9 p-0',
      lg: 'h-10 w-10 p-0',
    };
    return (
      <Button
        ref={ref}
        size={size}
        className={cn(square[size], className)}
        {...props}
      >
        {children}
      </Button>
    );
  },
);

IconButton.displayName = 'IconButton';
