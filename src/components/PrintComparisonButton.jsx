import { useAuth } from '../context/AuthContext';
import { PRINT_COMPARISON_EVENT, savePrintComparison } from '../lib/printComparisonHandoff';
import { toast } from './Toast';

export default function PrintComparisonButton({ beforeText = '', afterText, listName = 'Compared lists', mode = 'changes', className = 'btn btn-primary btn-sm' }) {
  const { user } = useAuth();
  if (!afterText?.trim()) return null;
  function openReview() {
    try {
      savePrintComparison(window.sessionStorage, { beforeText, afterText, listName, mode }, user?.id);
      window.dispatchEvent(new Event(PRINT_COMPARISON_EVENT));
      window.location.hash = '#print-list';
    } catch (error) {
      toast.error(error?.name === 'QuotaExceededError' || error?.name === 'SecurityError'
        ? 'Allow browser storage to carry these lists into print review.' : error.message);
    }
  }
  return <button type="button" className={className} onClick={openReview}
    title="Choose changes or the full list, review artwork, then generate a PDF or print">Print cards</button>;
}
