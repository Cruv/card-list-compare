import PrintPanel from './PrintPanel';
import { useAuth } from '../context/AuthContext';
import './PrintPanel.css';

export default function PrintListPage({ initialComparison, onComparisonConsumed }) {
  const { user } = useAuth();
  return <main className="print-list-page">
    <nav className="print-list-nav" aria-label="Print list navigation"><a href="#">← Compare</a><a href="#library">Deck library</a><a href="#print-station">Print Station</a><a href="#guide">Guide</a></nav>
    <header className="print-list-header"><h1>Print cards</h1><p>Choose your cards, check the artwork, then make your PDFs.</p></header>
    <PrintPanel key={user.id} standalone initialComparison={initialComparison} onComparisonConsumed={onComparisonConsumed} />
  </main>;
}
