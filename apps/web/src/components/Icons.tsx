import type { CSSProperties } from 'react';

export function Crest({ size = 32 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
    <path d="M20 2 36 11v18L20 38 4 29V11L20 2Z" stroke="currentColor" strokeWidth="1.5" />
    <path d="m20 9 10 17H10L20 9Zm0 0v23M4 11l16 21 16-21M4 29l16-20 16 20" stroke="currentColor" strokeWidth="1" />
  </svg>;
}

export function Icon({ name, size = 20, style }: {
  name: 'plus' | 'arrow' | 'users' | 'door' | 'copy' | 'check' | 'book' | 'chevron' | 'grid' | 'link' | 'clock';
  size?: number;
  style?: CSSProperties;
}) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    users: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2" /></>,
    door: <><path d="M10 4H4v16h6m4-12 4 4-4 4m-6-4h12" /></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M15 8V4H4v11h4" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    book: <><path d="M3 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H3V4Zm18 0h-6a3 3 0 0 0-3 3v14a4 4 0 0 1 4-3h5V4Z" /></>,
    chevron: <path d="m9 5 7 7-7 7" />,
    grid: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></>,
    link: <><path d="m9 15 6-6m-5-2 2-2a5 5 0 0 1 7 7l-2 2M14 17l-2 2a5 5 0 0 1-7-7l2-2" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden="true">{paths[name]}</svg>;
}
