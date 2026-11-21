import { foilProfileLabel } from '../lib/printPaper';

export default function PrintFoilProfileSelect({ available, value, disabled, onChange }) {
  return <label className="print-list-name">Artwork color
    <select value={value ?? ''} disabled={disabled} onChange={event => onChange(event.target.value || undefined)}>
      <option value="">Standard</option>
      {value && !available.includes(value) && <option value={value} disabled>{foilProfileLabel(value)}</option>}
      {available.map(profile => <option key={profile} value={profile}>{foilProfileLabel(profile)}</option>)}
    </select>
  </label>;
}
