import PrintPanel from './PrintPanel';
import Icon from './Icon';
import { useAuth } from '../context/AuthContext';
import './PrintPanel.css';

export default function PrintListPage({ initialComparison, onComparisonConsumed }) {
  const { user } = useAuth();
  return <section className="print-list-page">
    <header className="page-heading print-list-header"><div><p className="eyebrow">Print studio</p><h1>Print cards</h1><p>A few extras or a whole deck. Build your list, choose the art and get your next batch ready for the table.</p></div><span className="print-studio-mark"><Icon name="print" size={34} /></span></header>
    <PrintPanel key={user.id} standalone initialComparison={initialComparison} onComparisonConsumed={onComparisonConsumed} />
  </section>;
}
