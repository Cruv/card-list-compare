import PrintPanel from './PrintPanel';
import { useAuth } from '../context/AuthContext';
import './PrintPanel.css';

export default function PrintListPage() {
  const { user } = useAuth();
  return <main className="print-list-page">
    <nav className="print-list-nav" aria-label="Print list navigation"><a href="#">← Compare</a><a href="#library">Deck library</a><a href="#print-station">Print Station</a><a href="#guide">Guide</a></nav>
    <header className="print-list-header"><h1>Print lists</h1><p>Print any cards you need, without creating or changing a tracked deck.</p></header>
    <PrintPanel key={user.id} standalone />
  </main>;
}
