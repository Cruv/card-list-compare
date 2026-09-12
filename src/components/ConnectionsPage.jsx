import ManaSyncSettings from './ManaSyncSettings';
import IntegrationAccess from './IntegrationAccess';
import Icon from './Icon';
import './ConnectionsPage.css';

export default function ConnectionsPage() {
  return <section className="connections-page">
    <header className="page-heading"><p className="eyebrow">Better together</p><h1>Your decks. Your collection.</h1><p>Connect ManaSync to see what you own while choosing cards to print. One original card covers as many proxies as you need.</p></header>
    <div className="connection-journey" aria-label="Connected workflow"><span><Icon name="library" /> Decks in CLC</span><Icon name="connections" /><span><Icon name="cards" /> Collection in ManaSync</span><Icon name="arrow" /><span><Icon name="print" /> Ready to print</span></div>
    <ManaSyncSettings />
    <details className="connection-deck-access"><summary><span><Icon name="connections" /><span>Let ManaSync use your CLC decks<small>Optional · browse decks and send proposed changes back to CLC</small></span></span><Icon name="chevron" size={18} /></summary><IntegrationAccess /></details>
    <a className="connection-station-link" href="#print-station"><span><Icon name="station" /><span>Looking for Discord flip alerts?<small>Connect notifications in your household print station.</small></span></span><Icon name="arrow" /></a>
  </section>;
}
