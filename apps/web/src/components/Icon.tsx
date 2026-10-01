import type { ReactNode } from "react";

const paths = {
  workbench: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 4v16M8 9h13" /></>,
  review: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m8 12 3 3 5-6" /></>,
  releases: <><path d="m3 7 9-4 9 4v11l-9 4-9-4V7Zm0 0 9 4 9-4M12 11v11M7.5 5l9 4" /></>,
  activity: <><path d="M4 5h16M4 12h5l3-5 4 10 2-5h2M4 19h7" /></>,
  settings: <><path d="M4 6h16M4 12h16M4 18h16" /><path d="M8 3v6M16 9v6M10 15v6" /></>,
  ok: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
  warn: <><path d="M10.3 4a2 2 0 0 1 3.4 0L22 18a2 2 0 0 1-1.7 3H3.7A2 2 0 0 1 2 18L10.3 4Z" /><path d="M12 9v4m0 4h.01" /></>,
  bad: <><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10h.01" /></>,
  idle: <circle cx="12" cy="12" r="8" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  star: <path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3-5.7-3-5.7 3 1.1-6.3-4.6-4.5 6.4-.9L12 3Z" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
