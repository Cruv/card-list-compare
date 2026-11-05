const paths = {
  compare: 'M4 7h14m-4-4 4 4-4 4M20 17H6m4-4-4 4 4 4',
  library: 'M4 4h4v16H4zM10 4h4v16h-4zM16 5l4-1 4 15-4 1z',
  print: 'M7 8V3h10v5M7 17H4V9h16v8h-3M7 14h10v7H7zM17 11h.01',
  station: 'M4 4h16v12H4zM8 21h8m-4-5v5M8 10l3 3 5-6',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',
  connections: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
  guide: 'M12 5C8 2 4 3 2 4v15c4-2 7-1 10 1 3-2 6-3 10-1V4c-2-1-6-2-10 1zm0 0v15',
  search: 'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15M16 16l5 5',
  plus: 'M12 5v14M5 12h14',
  chevron: 'm9 5 7 7-7 7',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6',
  close: 'm6 6 12 12M6 18 18 6',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1',
  moon: 'M20 15a9 9 0 0 1-11-11 9 9 0 1 0 11 11z',
  user: 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M4 21v-2a8 8 0 0 1 16 0v2',
  shield: 'M12 3 3 7v5c0 5 9 10 9 10s9-5 9-10V7zM8 12l3 3 5-6',
  check: 'm5 12 4 4L19 6',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  cards: 'M8 3h12v17H8zM5 6H3v16h12',
  logout: 'M9 4H4v16h5M10 12h11m-5-5 5 5-5 5',
  pin: 'm8 3 8 0-1 7 4 4H5l4-4-1-7M12 14v8',
  lock: 'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3',
  unlock: 'M7 10V7a5 5 0 0 1 9-3M5 10h14v11H5zM12 14v3',
  edit: 'm4 16 12-12 4 4-12 12-5 1zM14 6l4 4',
};

export default function Icon({ name, size = 20, ...props }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}><path d={paths[name] || paths.cards} /></svg>;
}
