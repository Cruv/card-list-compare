import { memo } from 'react';
import './Skeleton.css';

export default memo(function Skeleton({ lines = 3, width }) {
  return (
    <div className="skeleton" style={width ? { maxWidth: width } : undefined}>
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="skeleton-line"
          style={{ width: i === lines - 1 ? '60%' : undefined }}
        />
      ))}
    </div>
  );
});
