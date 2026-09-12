import { memo, useState, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAppSettings } from '../context/AppSettingsContext';
import ManaCost from './ManaCost';
import Icon from './Icon';
import { useModalLayer } from '../lib/useModalLayer';
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
  const dialogRef = useRef(null);
  useModalLayer(onClose, { containerRef: dialogRef });
  if (!imageUri) return null;

  return createPortal(
    <div className="card-overlay" onClick={e => { e.stopPropagation(); onClose(); }}>
      <div className="card-overlay-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label={name} tabIndex={-1}
        onClick={e => e.stopPropagation()}>
        <button type="button" className="card-overlay-close" onClick={onClose} aria-label="Close card preview"><Icon name="close" /></button>
        <img src={imageUri} alt={name} className="card-overlay-img" loading="eager" />
        <span className="card-overlay-name">{name}</span>
      </div>
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
      {isFoil && <span className="card-line-foil" title="Foil" aria-label="Foil">&#10022;</span>}
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
    if (imageUri) setOverlayOpen(true);
  }, [imageUri]);
  const closeOverlay = useCallback(() => setOverlayOpen(false), []);
  const tooltip = !isTouch && hovering && !overlayOpen && imageUri && createPortal(
    <CardTooltip imageUri={imageUri} name={name} triggerRef={nameRef} />, document.body
  );
  const isPrinting = changeType === 'printing';
  const isQuantityChange = changeType === 'changed';

  return (
    <div className={`card-line card-line--${changeType}`}
      onMouseEnter={isTouch ? undefined : () => setHovering(true)}
      onMouseLeave={isTouch ? undefined : () => setHovering(false)}>
      <span className="card-line-count">
        {changeType !== 'list' && <span className="card-line-prefix" aria-hidden="true">{changeType === 'in' ? '+' : changeType === 'out' ? '−' : '~'}</span>}
        {!isQuantityChange && <span className="card-line-qty">{quantity}</span>}
      </span>
      <div className="card-line-main">
        {imageUri ? <button type="button" className="card-line-name card-line-preview" ref={nameRef} onClick={handleClick}
          aria-label={`View ${name}`} aria-haspopup="dialog">{name}</button>
          : <span className="card-line-name" ref={nameRef}>{name}</span>}
        {isPrinting ? <span className="card-line-detail">
          <PrintingBadge setCode={oldSetCode} collectorNumber={oldCollectorNumber} isFoil={oldIsFoil} />
          <span aria-label="changes to">→</span>
          <PrintingBadge setCode={newSetCode} collectorNumber={newCollectorNumber} isFoil={newIsFoil} />
        </span> : <PrintingBadge setCode={setCode} collectorNumber={collectorNumber} isFoil={isFoil} />}
        {isQuantityChange && <span className="card-line-detail">{oldQty} → {newQty} ({delta > 0 ? '+' : ''}{delta})</span>}
      </div>
      {manaCost && <ManaCost cost={manaCost} />}
      <PriceBadge price={totalPrice} cheapestPrice={cheapestTotalPrice} unitPrice={unitPrice} quantity={quantity} />
      {tooltip}
      {overlayOpen && <CardOverlay imageUri={imageUri} name={name} onClose={closeOverlay} />}
    </div>
  );
});
