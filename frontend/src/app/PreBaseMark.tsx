import React from 'react';

interface PreBaseMarkProps {
  size?: number;
  className?: string;
}

/**
 * Authentic PreBase monogram mark (PB geometric rounded-stroke ligature).
 * Uses `currentColor` on a transparent canvas so it adapts cleanly to dark
 * and light themes without background seams or artificial glow.
 */
export const PreBaseMark: React.FC<PreBaseMarkProps> = ({ size = 18, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 32 32"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={`prebase-mark ${className}`.trim()}
    aria-hidden="true"
  >
    {/* Inner P stem + arch */}
    <path
      d="M5.7 28V17.5C5.7 14.4624 8.16243 12 11.2 12H19.6"
      stroke="currentColor"
      strokeWidth="2.65"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    {/* Outer B top bar, upper loop, middle bar, lower loop, bottom bar (continuous) */}
    <path
      d="M5.7 4H19.5C23.4 4 26.3 7.1 26.3 11C26.3 14.9 23.4 18 19.5 18H11.8M19.5 18C24.0 18 27.1 20.2 27.1 23C27.1 25.8 24.0 28 19.5 28H11.5"
      stroke="currentColor"
      strokeWidth="2.65"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
