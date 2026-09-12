import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useModalLayer } from '../lib/useModalLayer';
import AuthBar from './AuthBar';
import Icon from './Icon';
import './AppShell.css';

const PRIMARY = [
  { route: 'main', href: '#', label: 'Compare', icon: 'compare' },
  { route: 'library', href: '#library', label: 'Deck library', short: 'Decks', icon: 'library' },
  { route: 'printList', href: '#print-list', label: 'Print studio', short: 'Print', icon: 'print' },
  { route: 'printStation', href: '#print-station', label: 'Print station', short: 'Station', icon: 'station' },
];
const SECONDARY = [
  { route: 'connections', href: '#connections', label: 'Connections', icon: 'connections' },
  { route: 'guide', href: '#guide', label: 'Guide', icon: 'guide' },
  { route: 'settings', href: '#settings', label: 'Account settings', icon: 'settings' },
];
const TITLES = { main: 'Compare lists', share: 'Shared comparison', library: 'Deck library', libraryDeck: 'Your deck', deck: 'Shared deck', printList: 'Print studio', printStation: 'Print station', connections: 'Connections', guide: 'Guide', settings: 'Account settings', admin: 'Administration' };

function keepFocusedControlVisible(event) {
  const target = event.target, workspace = event.currentTarget;
  // Browsers scroll focus into the viewport without accounting for fixed bars.
  // Measure after input-driven layout changes, such as the print review footer.
  requestAnimationFrame(() => {
    if (!target.isConnected || document.activeElement !== target || !workspace.contains(target)
      || target.closest('[role="dialog"], dialog')) return;
    const viewport = window.visualViewport;
    const top = (viewport?.offsetTop || 0) + 12;
    let bottom = (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight) - 12;
    const rect = target.getBoundingClientRect();
    for (const bar of document.querySelectorAll('.shell-mobile-nav, .print-review-footer')) {
      if (bar.contains(target)) continue;
      const cover = bar.getBoundingClientRect();
      if (cover.height && cover.top > top && cover.top < bottom
        && cover.right > rect.left && cover.left < rect.right) bottom = cover.top - 12;
    }
    if (bottom <= top || (rect.top >= top && rect.bottom <= bottom)) return;
    const delta = rect.height > bottom - top || rect.top < top
      ? rect.top - top : rect.bottom - bottom;
    window.scrollBy({ top: delta, behavior: 'auto' });
  });
}

function navigateFromShell(event, onNavigate) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const destination = new URL(event.currentTarget.href).hash;
  onNavigate?.();
  // Keep native hash history and its saved scroll position. Reset only after
  // an explicit navigation click, not on polling, deck tabs, or history travel.
  requestAnimationFrame(() => {
    if (window.location.hash === destination) window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  });
}

function NavItem({ item, route, compact, onNavigate }) {
  const active = route === item.route || item.route === 'library' && route === 'libraryDeck' || item.route === 'main' && route === 'share';
  return <a href={item.href} className={`shell-nav-item${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined} onClick={event => navigateFromShell(event, onNavigate)}><Icon name={item.icon} /><span>{compact ? item.short || item.label : item.label}</span></a>;
}
function MoreDrawer({ items, route, onClose, version, onWhatsNew }) {
  const ref = useRef(null);
  useModalLayer(onClose, { containerRef: ref });
  return <div className="shell-drawer-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}><section className="shell-drawer" ref={ref} role="dialog" aria-modal="true" aria-labelledby="shell-more-title" tabIndex={-1}><header><h2 id="shell-more-title">Your workspace</h2><button className="shell-icon-button" onClick={onClose} aria-label="Close navigation"><Icon name="close" /></button></header><nav aria-label="More navigation">{items.map(item => <NavItem key={item.route} item={item} route={route} onNavigate={onClose} />)}</nav><button className="shell-version" onClick={() => { onClose(); onWhatsNew(); }}>What’s new · v{version}</button></section></div>;
}
export default function AppShell({ children, route, version, onWhatsNew, onShowForgotPassword }) {
  const { user } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 801px)');
    const closeDesktopDrawer = event => { if (event.matches) setMoreOpen(false); };
    desktop.addEventListener('change', closeDesktopDrawer);
    return () => desktop.removeEventListener('change', closeDesktopDrawer);
  }, []);
  const secondary = user?.isAdmin ? [...SECONDARY, { route: 'admin', href: '#admin', label: 'Administration', icon: 'shield' }] : SECONDARY;
  return <div className="workspace-shell">
    <a className="sr-only sr-only-focusable" href="#workspace-main" onClick={event => { event.preventDefault(); document.getElementById('workspace-main')?.focus(); }}>Skip to content</a>
    <aside className="shell-sidebar"><a href="#" className="shell-brand" aria-label="Card List Compare home" onClick={navigateFromShell}><span className="shell-brand-mark"><Icon name="cards" size={26} /></span><span>Card List<span className="shell-brand-second">Compare</span></span></a><div className="shell-nav-label">Workspace</div><nav aria-label="Main navigation">{PRIMARY.map(item => <NavItem key={item.route} item={item} route={route} />)}</nav><div className="shell-nav-label shell-nav-label--secondary">Manage</div><nav aria-label="Workspace settings">{secondary.map(item => <NavItem key={item.route} item={item} route={route} />)}</nav><div className="shell-sidebar-footer"><div className="shell-footer-note"><Icon name="cards" size={16} /> More time at the table.</div><button className="shell-version" onClick={onWhatsNew}>What’s new · v{version}</button></div></aside>
    <div className="shell-workspace"><header className="shell-topbar"><span className="shell-context"><span className="shell-context-brand">CLC<span>/</span></span>{TITLES[route] || 'Compare lists'}</span><AuthBar onShowForgotPassword={onShowForgotPassword} /></header><main id="workspace-main" className={`shell-content shell-content--${route}`} tabIndex={-1} onFocusCapture={keepFocusedControlVisible} onInputCapture={keepFocusedControlVisible}>{children}</main></div>
    <nav className="shell-mobile-nav" aria-label="Mobile navigation">{PRIMARY.map(item => <NavItem key={item.route} item={item} route={route} compact />)}<button className={`shell-nav-item${secondary.some(item => item.route === route) ? ' is-active' : ''}`} onClick={event => { event.currentTarget.focus(); setMoreOpen(true); }} aria-expanded={moreOpen} aria-haspopup="dialog"><Icon name="more" /><span>More</span></button></nav>
    {moreOpen && <MoreDrawer items={secondary} route={route} onClose={() => setMoreOpen(false)} version={version} onWhatsNew={onWhatsNew} />}
  </div>;
}
