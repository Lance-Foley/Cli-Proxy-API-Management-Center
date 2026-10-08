/**
 * Usage meter. `percent` is the share already used (0–100).
 * The fill is always green and grows as the allowance is used.
 * A full bar means the allowance is used up. Unknown usage stays an empty track.
 */

import type { CSSProperties } from 'react';
import type { QuotaClassMap } from '../types';

export interface QuotaMeterProps {
  percent: number | null;
  classes: QuotaClassMap;
  index?: number;
}

export function QuotaMeter({ percent, classes, index }: QuotaMeterProps) {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const normalized = percent === null ? null : clamp(percent, 0, 100);
  const widthPercent = Math.round((normalized ?? 0) * 100) / 100;
  const style: CSSProperties & { '--meter-index'?: number } = { width: `${widthPercent}%` };
  if (index !== undefined) {
    style['--meter-index'] = index;
  }

  return (
    <div className={classes.quotaBar}>
      <div className={`${classes.quotaBarFill} ${classes.quotaBarFillHigh}`} style={style} />
    </div>
  );
}
