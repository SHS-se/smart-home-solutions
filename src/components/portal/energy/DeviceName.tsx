import React from 'react';

/** Saved device identity, shared by lists, breakdowns and other references. */
export default function DeviceName({ name, colour, deviceKey, className = '' }: {
  name: string; colour: string; deviceKey: string; className?: string;
}) {
  return <span className={`inline-flex min-w-0 items-center gap-2 ${className}`}>
    <span aria-hidden="true" data-device-colour={deviceKey}
      className="inline-block h-3 w-3 shrink-0 rounded-sm border border-black/15 dark:border-white/25"
      style={{ backgroundColor: colour }} />
    <span className="truncate">{name}</span>
  </span>;
}
