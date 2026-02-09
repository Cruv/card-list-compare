import { memo } from 'react';
import './CardLine.css';

export default memo(function CardLine({ name, quantity, changeType, oldQty, newQty, delta }) {
  if (changeType === 'in') {
    return (
      <div className="card-line card-line--in">
        <span className="card-line-prefix">+</span>
        <span className="card-line-qty">{quantity}</span>
        <span className="card-line-name">{name}</span>
      </div>
    );
  }

  if (changeType === 'out') {
    return (
      <div className="card-line card-line--out">
        <span className="card-line-prefix">-</span>
        <span className="card-line-qty">{quantity}</span>
        <span className="card-line-name">{name}</span>
      </div>
    );
  }

  // changeType === 'changed'
  const sign = delta > 0 ? '+' : '';
  return (
    <div className="card-line card-line--changed">
      <span className="card-line-prefix">~</span>
      <span className="card-line-name">{name}</span>
      <span className="card-line-detail">
        {oldQty} &rarr; {newQty} ({sign}{delta})
      </span>
    </div>
  );
});
