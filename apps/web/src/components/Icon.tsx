import type { ReactNode } from "react";

/** One stroke family (24px grid, 1.6 stroke, round caps). Filled shapes set `fill` themselves. */
const paths = {
  sheet: <><rect x="3.5" y="3.5" width="7" height="7" rx="1" /><rect x="13.5" y="3.5" width="7" height="7" rx="1" fill="currentColor" /><rect x="3.5" y="13.5" width="7" height="7" rx="1" fill="currentColor" /><rect x="13.5" y="13.5" width="7" height="7" rx="1" strokeDasharray="2 2" /></>,
  "chevron-down": <path d="m7 10 5 5 5-5" />,
  "chevron-up": <path d="m7 14 5-5 5 5" />,
  "chevron-left": <path d="m14 7-5 5 5 5" />,
  "chevron-right": <path d="m10 7 5 5-5 5" />,
  "arrow-right": <path d="M5 12h13m-5-5 5 5-5 5" />,
  "arrow-left": <path d="M19 12H6m5-5-5 5 5 5" />,
  search: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></>,
  settings: <><path d="M4 7.5h9m4 0h3M4 16.5h3m4 0h9" /><circle cx="15" cy="7.5" r="2" /><circle cx="9" cy="16.5" r="2" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  close: <path d="m6.5 6.5 11 11m0-11-11 11" />,
  lock: <><rect x="5.5" y="10.5" width="13" height="9" rx="1.5" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>,
  unlock: <><rect x="5.5" y="10.5" width="13" height="9" rx="1.5" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.2" /></>,
  clock: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4.5l3 1.8" /></>,
  note: <path d="M5 5.5h14v10H11l-4 3.5v-3.5H5z" />,
  alert: <><path d="M12 4 21 19.5H3z" /><path d="M12 10v4.5m0 2.5v.2" /></>,
  refresh: <path d="M19 12a7 7 0 1 1-2-4.9M19 4.5V8h-3.5" />,
  play: <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />,
  pause: <path d="M8 5.5v13M16 5.5v13" />,
  loop: <path d="M7 9.5h9.5a3.5 3.5 0 0 1 0 7H15M7 9.5 9.5 7M7 9.5 9.5 12M17 14.5H7.5a3.5 3.5 0 0 1 0-7" />,
  "step-back": <path d="M7 6v12M18 6l-8 6 8 6z" />,
  "step-forward": <path d="M17 6v12M6 6l8 6-8 6z" />,
  pin: <><path d="M12 20.5s6-5.6 6-10.5a6 6 0 0 0-12 0c0 4.9 6 10.5 6 10.5z" /><circle cx="12" cy="10" r="2" /></>,
  rect: <rect x="4.5" y="6.5" width="15" height="11" rx="1" strokeDasharray="3 2" />,
  hand: <path d="M8.5 12V6.5a1.5 1.5 0 0 1 3 0V11m0-5.5V5a1.5 1.5 0 0 1 3 0v6m0-4.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.6a6 6 0 0 1-4.6-2.2L5 15.4a1.5 1.5 0 0 1 2.3-1.9l1.2 1.4" />,
  frame: <path d="M4.5 8V4.5H8M16 4.5h3.5V8M19.5 16v3.5H16M8 19.5H4.5V16" />,
  more: <><circle cx="6" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="18" cy="12" r="1.2" fill="currentColor" /></>,
  star: <path d="m12 4.5 2.3 4.8 5.2.7-3.8 3.6.9 5.2-4.6-2.5-4.6 2.5.9-5.2-3.8-3.6 5.2-.7z" />,
  "star-fill": <path d="m12 4.5 2.3 4.8 5.2.7-3.8 3.6.9 5.2-4.6-2.5-4.6 2.5.9-5.2-3.8-3.6 5.2-.7z" fill="currentColor" />,
  branch: <><circle cx="7" cy="6" r="2" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="8" r="2" /><path d="M7 8v8M17 10c0 4-5 3.5-9.2 6.6" /></>,
  package: <><path d="m12 3.5 8 4v9l-8 4-8-4v-9z" /><path d="m4 7.5 8 4 8-4M12 11.5v9" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>,
  compare: <><rect x="3.5" y="5.5" width="7.5" height="13" rx="1" /><rect x="13" y="5.5" width="7.5" height="13" rx="1" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2m0 15v2M2.5 12h2m15 0h2M5.3 5.3l1.4 1.4m10.6 10.6 1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></>,
  moon: <path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z" />,
  monitor: <><rect x="3.5" y="4.5" width="17" height="11.5" rx="1.5" /><path d="M9 20h6M12 16v4" /></>,
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  edit: <path d="m14.5 5.5 4 4L9 19H5v-4zM12.5 7.5l4 4" />,
  trash: <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />,
  download: <path d="M12 4.5v11m-4.5-4.5 4.5 4.5 4.5-4.5M5 19.5h14" />,
  upload: <path d="M12 15.5v-11M7.5 9 12 4.5 16.5 9M5 19.5h14" />,
  external: <path d="M14 4.5h5.5V10M19.5 4.5 11 13M10 6H5.5v12.5H18V14" />,
  image: <><rect x="4" y="5" width="16" height="14" rx="1.5" /><circle cx="9" cy="10" r="1.6" /><path d="m4.5 17 4.5-4.5 3.5 3.5 2.5-2.5 4.5 4.5" /></>,
  film: <><rect x="4" y="4.5" width="16" height="15" rx="1.5" /><path d="M8 4.5v15M16 4.5v15M4 9h4m8 0h4M4 15h4m8 0h4" /></>,
  layers: <path d="m12 4 8.5 4.5L12 13 3.5 8.5zM3.5 12.5 12 17l8.5-4.5M3.5 16.5 12 21l8.5-4.5" />,
  spark: <path d="M12 3.5v5M12 15.5v5M3.5 12h5M15.5 12h5" />,
  history: <><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3.5H8" /><path d="M12 8v4.5l3 1.8" /></>,
  activity: <path d="M3.5 12h4l2.5-6 4 12 2.5-6h4" />,
  plug: <path d="M9 4.5V9m6-4.5V9M7 9h10v3a5 5 0 0 1-10 0zM12 17v3.5" />,
  robot: <><rect x="5" y="8" width="14" height="10.5" rx="2" /><path d="M12 4.5V8M9.5 13h.01M14.5 13h.01M9.5 16h5" /></>,
  ok: <><circle cx="12" cy="12" r="8.5" /><path d="m8.5 12.2 2.4 2.4 4.6-5" /></>,
  warn: <><path d="M12 4 21 19.5H3z" /><path d="M12 10v4.5m0 2.5v.2" /></>,
  bad: <><circle cx="12" cy="12" r="8.5" /><path d="m9.2 9.2 5.6 5.6m0-5.6-5.6 5.6" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5m0-8.5v.2" /></>,
  idle: <circle cx="12" cy="12" r="7.5" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

export function Icon({ name, className = "", size }: { name: IconName; className?: string; size?: "sm" | "lg" }) {
  return (
    <svg className={`icon${size ? ` icon-${size}` : ""}${className ? ` ${className}` : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  );
}
