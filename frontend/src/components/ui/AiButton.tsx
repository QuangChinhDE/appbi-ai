'use client';

/**
 * AiButton — THE one visual identity for every AI-triggering action across the
 * app (reference: the Dataset "Auto-detect types" button): a brand-tinted pill
 * with a Wand2 icon. Any button that calls AI must use this so users instantly
 * recognize "this touches AI" anywhere in the system.
 *
 * Size stability: the button NEVER resizes on state change — while `loading`,
 * a spinner replaces the wand icon but the label stays the same (callers must
 * not swap labels while busy).
 */
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Loader2, Wand2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface AiButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
  size?: 'xs' | 'sm' | 'md';
}

const SIZES = {
  xs: 'gap-1 px-2 py-0.5 text-tiny',
  sm: 'gap-1.5 px-2.5 py-1 text-xs',
  md: 'gap-1.5 px-3 py-1.5 text-caption',
} as const;
const ICONS = { xs: 'h-3 w-3', sm: 'h-3.5 w-3.5', md: 'h-4 w-4' } as const;

export const AiButton = forwardRef<HTMLButtonElement, AiButtonProps>(function AiButton(
  { loading = false, size = 'sm', className, children, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-md border font-medium transition-colors',
        'border-brand/25 bg-brand/10 text-brand hover:border-brand/40 hover:bg-brand/20',
        'disabled:cursor-not-allowed disabled:opacity-60',
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading
        ? <Loader2 className={cn(ICONS[size], 'flex-shrink-0 animate-spin')} />
        : <Wand2 className={cn(ICONS[size], 'flex-shrink-0')} />}
      {children}
    </button>
  );
});
