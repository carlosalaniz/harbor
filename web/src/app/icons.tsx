import type { ReactNode } from 'react';

// One small geometric mark for Harbor: a harbour basin (circle) with an entry channel.
// Stroke-only, currentColor, works at 14–32px next to the wordmark.
export function Mark({ size = 20 }: { size?: number }): ReactNode {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" aria-hidden="true">
      <circle cx="10" cy="10" r="6.5" />
      <path d="M10 3.5v3M10 13.5v3M3.5 10h3M13.5 10h3" />
      <circle cx="10" cy="10" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function PencilIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11.5 2.8a1.6 1.6 0 0 1 2.3 2.3L5.5 13.4l-3 1 1-3 8-8.6Z" />
    </svg>
  );
}

export function EllipsisIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="12.5" cy="8" r="1.4" />
    </svg>
  );
}

export function ArrowUpIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 13V3M4 7l4-4 4 4" />
    </svg>
  );
}

export function EyeIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.8 8S4 4.2 8 4.2 14.2 8 14.2 8 12 11.8 8 11.8 1.8 8 1.8 8Z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

export function EyeOffIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3l10 10M6.6 6.7A2 2 0 0 0 9.4 9.4M4.2 4.5C2.9 5.6 1.8 8 1.8 8s2.2 3.8 6.2 3.8c1.1 0 2.1-.3 3-.8M7 4.3c.3-.1.7-.1 1-.1 4 0 6.2 3.8 6.2 3.8s-.5.9-1.5 1.9" />
    </svg>
  );
}
