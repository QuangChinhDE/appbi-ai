'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  invalid?: boolean;
}

const sizeMap = {
  sm: 'h-8 text-caption',
  md: 'h-9 text-caption',
  lg: 'h-10 text-small',
} as const;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, leadingIcon, trailingIcon, size = 'md', invalid, ...props }, ref) => {
    const hasLeading = !!leadingIcon;
    const hasTrailing = !!trailingIcon;
    const input = (
      <input
        ref={ref}
        className={cn(
          'w-full rounded-md bg-surface-1 text-text-primary placeholder:text-text-quaternary',
          'border transition-[border-color,box-shadow] duration-150 outline-none',
          invalid
            ? 'border-danger/60 focus:shadow-[0_0_0_3px_rgb(220_38_38/0.15)]'
            : 'border-[rgb(var(--border-strong))] focus:border-brand focus:shadow-focus-brand',
          sizeMap[size],
          hasLeading ? 'pl-9' : 'pl-3',
          hasTrailing ? 'pr-9' : 'pr-3',
          'disabled:cursor-not-allowed disabled:opacity-60 disabled:bg-surface-2',
          className,
        )}
        {...props}
      />
    );
    if (!hasLeading && !hasTrailing) return input;
    return (
      <div className="relative flex items-center">
        {hasLeading && (
          <span className="pointer-events-none absolute left-3 text-text-tertiary [&_svg]:h-4 [&_svg]:w-4">
            {leadingIcon}
          </span>
        )}
        {input}
        {hasTrailing && (
          <span className="absolute right-3 text-text-tertiary [&_svg]:h-4 [&_svg]:w-4">
            {trailingIcon}
          </span>
        )}
      </div>
    );
  },
);

Input.displayName = 'Input';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, invalid, rows = 4, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        rows={rows}
        className={cn(
          'w-full rounded-md bg-surface-1 text-text-primary placeholder:text-text-quaternary',
          'border transition-[border-color,box-shadow] duration-150 outline-none',
          'px-3 py-2 text-caption leading-relaxed resize-y',
          invalid
            ? 'border-danger/60 focus:shadow-[0_0_0_3px_rgb(220_38_38/0.15)]'
            : 'border-[rgb(var(--border-strong))] focus:border-brand focus:shadow-focus-brand',
          'disabled:cursor-not-allowed disabled:opacity-60 disabled:bg-surface-2',
          className,
        )}
        {...props}
      />
    );
  },
);

Textarea.displayName = 'Textarea';

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: 'sm' | 'md' | 'lg';
  invalid?: boolean;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, size = 'md', invalid, children, ...props }, ref) => {
    return (
      <select
        ref={ref}
        className={cn(
          'w-full rounded-md bg-surface-1 text-text-primary',
          'border transition-[border-color,box-shadow] duration-150 outline-none',
          'px-3 pr-8 appearance-none',
          'bg-[url("data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27 width=%2716%27 height=%2716%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%238a8f98%27 stroke-width=%272%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27><polyline points=%276 9 12 15 18 9%27/></svg>")]',
          'bg-no-repeat bg-[right_0.625rem_center]',
          invalid
            ? 'border-danger/60 focus:shadow-[0_0_0_3px_rgb(220_38_38/0.15)]'
            : 'border-[rgb(var(--border-strong))] focus:border-brand focus:shadow-focus-brand',
          sizeMap[size],
          'disabled:cursor-not-allowed disabled:opacity-60 disabled:bg-surface-2',
          className,
        )}
        {...props}
      >
        {children}
      </select>
    );
  },
);

Select.displayName = 'Select';

export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  required?: boolean;
}

export const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, required, children, ...props }, ref) => (
    <label
      ref={ref}
      className={cn('text-label text-text-secondary font-emphasis', className)}
      {...props}
    >
      {children}
      {required && <span className="ml-0.5 text-danger">*</span>}
    </label>
  ),
);

Label.displayName = 'Label';

export function FieldGroup({
  label,
  required,
  description,
  error,
  htmlFor,
  className,
  children,
}: {
  label?: React.ReactNode;
  required?: boolean;
  description?: React.ReactNode;
  error?: React.ReactNode;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <Label htmlFor={htmlFor} required={required}>
          {label}
        </Label>
      )}
      {children}
      {description && !error && (
        <p className="text-caption text-text-tertiary">{description}</p>
      )}
      {error && <p className="text-caption text-danger">{error}</p>}
    </div>
  );
}
