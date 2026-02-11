import { memo, useState, useRef, useMemo } from 'react';
import ManaCost from './ManaCost';
import './CardLine.css';

function CardTooltip({ imageUri, name, triggerRef }) {
  // Compute position once on mount — triggerRef is stable while hovering
  const pos = useMemo(() => {
    if (!triggerRef.current) return { top: 0, left: 0 };
    const rect = triggerRef.current.getBoundingClientRect();
    const tooltipHeight = 310;
    const tooltipWidth = 224;

    let top = rect.top - tooltipHeight - 8;
    let left = rect.left + rect.width / 2 - tooltipWidth / 2;

    // If tooltip would go above viewport, show below
    if (top < 8) {
      top = rect.bottom + 8;
    }
    // Keep within horizontal bounds
    if (left < 8) left = 8;
    if (left + tooltipWidth > window.innerWidth - 8) {
      left = window.innerWidth - tooltipWidth - 8;
    }

    return { top, left };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!imageUri) return null;

  return (
    <div
      className="card-tooltip"
      style={{ top: pos.top, left: pos.left }}
    >
      <img
        src={imageUri}
        alt={name}
        className="card-tooltip-img"
        loading="eager"
      />
    </div>
  );
}

export default memo(function CardLine({ name, quantity, changeType, oldQty, newQty, delta, manaCost, imageUri }) {
  const [hovering, setHovering] = useState(false);
  const nameRef = useRef(null);

  if (changeType === 'in') {
    return (
      <div
        className="card-line card-line--in"
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <span className="card-line-prefix">+</span>
        <span className="card-line-qty">{quantity}</span>
        <span className="card-line-name" ref={nameRef}>{name}</span>
        {manaCost && <ManaCost cost={manaCost} />}
        {hovering && imageUri && <CardTooltip imageUri={imageUri} name={name} triggerRef={nameRef} />}
      </div>
    );
  }

  if (changeType === 'out') {
    return (
      <div
        className="card-line card-line--out"
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <span className="card-line-prefix">-</span>
        <span className="card-line-qty">{quantity}</span>
        <span className="card-line-name" ref={nameRef}>{name}</span>
        {manaCost && <ManaCost cost={manaCost} />}
        {hovering && imageUri && <CardTooltip imageUri={imageUri} name={name} triggerRef={nameRef} />}
      </div>
    );
  }

  // changeType === 'changed'
  const sign = delta > 0 ? '+' : '';
  return (
    <div
      className="card-line card-line--changed"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <span className="card-line-prefix">~</span>
      <span className="card-line-name" ref={nameRef}>{name}</span>
      {manaCost && <ManaCost cost={manaCost} />}
      <span className="card-line-detail">
        {oldQty} &rarr; {newQty} ({sign}{delta})
      </span>
      {hovering && imageUri && <CardTooltip imageUri={imageUri} name={name} triggerRef={nameRef} />}
    </div>
  );
});
