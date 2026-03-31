'use client';

interface OwnerBadgeProps {
  email?: string | null;
  className?: string;
}

export function OwnerBadge({ email, className = '' }: OwnerBadgeProps) {
  if (!email) return null;
  const label = email.split('@')[0];
  return (
    <span
      className={`inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 truncate max-w-[120px] ${className}`}
      title={email}
    >
      {label}
    </span>
  );
}
