import PrintPanel from './PrintPanel';
import Icon from './Icon';
import { useAuth } from '../context/AuthContext';
import './PrintPanel.css';

export default function PrintListPage({ initialComparison, onComparisonConsumed, initialPrintJobId }) {
  const { user } = useAuth();
  return <section className="print-list-page">
    <header className="page-heading print-list-header"><div><h1>Print a card list</h1><p>Import or paste cards, review their artwork, then generate PDFs or print.</p></div><span className="print-studio-mark"><Icon name="print" size={34} /></span></header>
    <PrintPanel key={user.id} standalone initialComparison={initialComparison} onComparisonConsumed={onComparisonConsumed} initialJobId={initialPrintJobId} />
  </section>;
}
