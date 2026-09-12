import ManaSyncSettings from './ManaSyncSettings';
import IntegrationAccess from './IntegrationAccess';
import Icon from './Icon';
import './ConnectionsPage.css';

export default function ConnectionsPage() {
  return <section className="connections-page">
    <header className="page-heading"><h1>Connections</h1><p>Choose what CLC and ManaSync can share with each other.</p></header>
    <ManaSyncSettings />
    <details className="connection-deck-access"><summary><span><Icon name="connections" /><span>CLC decks in ManaSync<small>Optional · let ManaSync read decks, propose edits or create new decks</small></span></span><Icon name="chevron" size={18} /></summary><IntegrationAccess /></details>
    <nav className="connection-related" aria-label="Related settings"><a href="#print-station">Printer and Discord alerts <Icon name="arrow" size={16} /></a><a href="#guide/connections">Connection help <Icon name="guide" size={16} /></a></nav>
  </section>;
}
