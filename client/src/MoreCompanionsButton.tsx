import type { ReactNode } from "react";

export function ExpandButton({ expanded, controls, onToggle, children, className = "" }: {
  expanded: boolean;
  controls: string;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
}) {
  return <button type="button" className={`more-companions-button ${className}`}
    aria-expanded={expanded} aria-controls={controls} onClick={onToggle}>
    <span>{children}</span>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  </button>;
}

export function MoreCompanionsButton({ expanded, controls, onToggle }: {
  expanded: boolean;
  controls: string;
  onToggle: () => void;
}) {
  return <ExpandButton expanded={expanded} controls={controls} onToggle={onToggle}>
    {expanded ? "Fewer companions" : "More companions"}
  </ExpandButton>;
}
