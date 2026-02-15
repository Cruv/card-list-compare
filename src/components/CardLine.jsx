import { memo, useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAppSettings } from '../context/AppSettingsContext';
import ManaCost from './ManaCost';
import './CardLine.css';

// Detect touch-primary device once
const isTouch = typeof window !== 'undefined' &&
  window.matchMedia('(hover: none)').matches;

function CardTooltip({ imageUri, name, triggerRef }) {
  const pos = useMemo(() => {
    if (!triggerRef.current) return { top: 0, left: 0 };
    const rect = triggerRef.current.getBoundingClientRect();
    const tooltipHeight = 310;
    const tooltipWidth = 224;

    let top = rect.top - tooltipHeight - 8;
    let left = rect.left + rect.width / 2 - tooltipWidth / 2;

    if (top < 8) {
      top = rect.bottom + 8;
    }
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

function CardOverlay({ imageUri, name, onClose }) {
  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  if (!imageUri) return null;

  return createPortal(
    <div className="card-overlay" onClick={e => { e.stopPropagation(); onClose(); }} role="dialog" aria-label={name}>
      <img
        src={imageUri}
        alt={name}
        className="card-overlay-img"
        loading="eager"
      />
      <span className="card-overlay-name">{name}</span>
    </div>,
    document.body
  );
}

function PrintingBadge({ setCode, collectorNumber, isFoil }) {
  if (!setCode && !isFoil) return null;
  return (
    <span className="card-line-printing">
      {setCode && <span className="card-line-set">({setCode.toUpperCase()})</span>}
      {collectorNumber && <span className="card-line-collector">#{collectorNumber}</span>}
      {isFoil && <span className="card-line-foil">&#10022;</span>}
    </span>
  );
}

function PriceBadge({ price, cheapestPrice, unitPrice, quantity }) {
  if (price == null && cheapestPrice == null) return null;
  const showCheapest = cheapestPrice != null && price != null && Math.abs(cheapestPrice - price) >= 0.01;
  const showUnit = unitPrice != null && quantity > 1;
  return (
    <span className="card-line-price">
      {price != null ? `$${price.toFixed(2)}` : ''}
      {showUnit && <span className="card-line-unit-price">${unitPrice.toFixed(2)} ea</span>}
      {showCheapest && <span className="card-line-cheapest-price">(${cheapestPrice.toFixed(2)})</span>}
      {price == null && cheapestPrice != null ? `$${cheapestPrice.toFixed(2)}` : ''}
    </span>
  );
}

export default memo(function CardLine({ name, quantity, changeType, oldQty, newQty, delta, manaCost, imageUri, setCode, collectorNumber, isFoil, priceUsd, priceUsdFoil, cheapestPriceUsd, cheapestPriceUsdFoil, oldSetCode, oldCollectorNumber, oldIsFoil, newSetCode, newCollectorNumber, newIsFoil }) {
  const { priceDisplayEnabled } = useAppSettings();
  const [hovering, setHovering] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const nameRef = useRef(null);

  const unitPrice = isFoil && priceUsdFoil != null ? priceUsdFoil : priceUsd;
  const totalPrice = priceDisplayEnabled && unitPrice != null && quantity ? unitPrice * quantity : null;
  // Cheapest unit price: lowest of foil and non-foil for this card name
  const cheapestUnitPrice = cheapestPriceUsd != null || cheapestPriceUsdFoil != null
    ? (cheapestPriceUsd != null && cheapestPriceUsdFoil != null
        ? Math.min(cheapestPriceUsd, cheapestPriceUsdFoil)
        : (cheapestPriceUsd ?? cheapestPriceUsdFoil))
    : null;
  const cheapestTotalPrice = priceDisplayEnabled && cheapestUnitPrice != null && quantity ? cheapestUnitPrice * quantity : null;

  const handleClick = useCallback(() => {
    if (isTouch && imageUri) {
      setOverlayOpen(true);
    }
  }, [imageUri]);

  const closeOverlay = useCallback(() => setOverlayOpen(false), []);

  const tooltip = !isTouch && hovering && imageUri && (
    <CardTooltip imageUri={imageUri} name={name} triggerRef={nameRef} />
  );
  const overlay = overlayOpen && (
    <CardOverlay imageUri={imageUri} name={name} onClose={closeOverlay} />
  );

  if (changeType === 'in') {
    return (
      <div
        className="card-line card-line--in"
        onMouseEnter={isTouch ? undefined : () => setHovering(true)}
        onMouseLeave={isTouch ? undefined : () => setHovering(false)}
        onClick={handleClick}
      >
        <span className="card-line-prefix">+</span>
        <span className="card-line-qty">{quantity}</span>
        <span className="card-line-name" ref={nameRef}>{name}</span>
        <PrintingBadge setCode={setCode} collectorNumber={collectorNumber} isFoil={isFoil} />
        {manaCost && <ManaCost cost={manaCost} />}
        <PriceBadge price={totalPrice} cheapestPrice={cheapestTotalPrice} unitPrice={unitPrice} quantity={quantity} />
        {tooltip}
        {overlay}
      </div>
    );
  }

  if (changeType === 'out') {
    return (
      <div
        className="card-line card-line--out"
        onMouseEnter={isTouch ? undefined : () => setHovering(true)}
        onMouseLeave={isTouch ? undefined : () => setHovering(false)}
        onClick={handleClick}
      >
        <span className="card-line-prefix">-</span>
        <span className="card-line-qty">{quantity}</span>
        <span className="card-line-name" ref={nameRef}>{name}</span>
        <PrintingBadge setCode={setCode} collectorNumber={collectorNumber} isFoil={isFoil} />
        {manaCost && <ManaCost cost={manaCost} />}
        <PriceBadge price={totalPrice} cheapestPrice={cheapestTotalPrice} unitPrice={unitPrice} quantity={quantity} />
        {tooltip}
        {overlay}
      </div>
    );
  }

  if (changeType === 'list') {
    return (
      <div
        className="card-line card-line--list"
        onMouseEnter={isTouch ? undefined : () => setHovering(true)}
        onMouseLeave={isTouch ? undefined : () => setHovering(false)}
        onClick={handleClick}
      >
        <span className="card-line-qty">{quantity}</span>
        <span className="card-line-name" ref={nameRef}>{name}</span>
        <PrintingBadge setCode={setCode} collectorNumber={collectorNumber} isFoil={isFoil} />
        {manaCost && <ManaCost cost={manaCost} />}
        <PriceBadge price={totalPrice} cheapestPrice={cheapestTotalPrice} unitPrice={unitPrice} quantity={quantity} />
        {tooltip}
        {overlay}
      </div>
    );
  }

  if (changeType === 'printing') {
    return (
      <div
        className="card-line card-line--printing"
        onMouseEnter={isTouch ? undefined : () => setHovering(true)}
        onMouseLeave={isTouch ? undefined : () => setHovering(false)}
        onClick={handleClick}
      >
        <span className="card-line-prefix">~</span>
        <span className="card-line-qty">{quantity}</span>
        <span className="card-line-name" ref={nameRef}>{name}</span>
        {manaCost && <ManaCost cost={manaCost} />}
        <PriceBadge price={totalPrice} cheapestPrice={cheapestTotalPrice} unitPrice={unitPrice} quantity={quantity} />
        <span className="card-line-detail">
          <PrintingBadge setCode={oldSetCode} collectorNumber={oldCollectorNumber} isFoil={oldIsFoil} />
          &nbsp;&rarr;&nbsp;
          <PrintingBadge setCode={newSetCode} collectorNumber={newCollectorNumber} isFoil={newIsFoil} />
        </span>
        {tooltip}
        {overlay}
      </div>
    );
  }

  // changeType === 'changed'
  const sign = delta > 0 ? '+' : '';
  return (
    <div
      className="card-line card-line--changed"
      onMouseEnter={isTouch ? undefined : () => setHovering(true)}
      onMouseLeave={isTouch ? undefined : () => setHovering(false)}
      onClick={handleClick}
    >
      <span className="card-line-prefix">~</span>
      <span className="card-line-name" ref={nameRef}>{name}</span>
      <PrintingBadge setCode={setCode} collectorNumber={collectorNumber} isFoil={isFoil} />
      {manaCost && <ManaCost cost={manaCost} />}
      <PriceBadge price={totalPrice} cheapestPrice={cheapestTotalPrice} unitPrice={unitPrice} quantity={quantity} />
      <span className="card-line-detail">
        {oldQty} &rarr; {newQty} ({sign}{delta})
      </span>
      {tooltip}
      {overlay}
    </div>
  );
});
