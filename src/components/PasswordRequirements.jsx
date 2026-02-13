import './PasswordRequirements.css';

const RULES = [
  { test: pw => pw.length >= 8, label: '8+ characters' },
  { test: pw => pw.length <= 128, label: '128 characters max' },
  { test: pw => /[a-z]/.test(pw), label: 'One lowercase letter' },
  { test: pw => /[A-Z]/.test(pw), label: 'One uppercase letter' },
  { test: pw => /[0-9]/.test(pw), label: 'One digit' },
];

export default function PasswordRequirements({ password }) {
  if (!password) return null;

  return (
    <ul className="pw-requirements">
      {RULES.map(rule => {
        const pass = rule.test(password);
        return (
          <li key={rule.label} className={pass ? 'pw-req-pass' : 'pw-req-fail'}>
            <span className="pw-req-icon">{pass ? '\u2713' : '\u2717'}</span>
            {rule.label}
          </li>
        );
      })}
    </ul>
  );
}
