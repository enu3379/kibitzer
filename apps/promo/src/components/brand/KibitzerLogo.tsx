import React from "react";

/**
 * Faithful React port of apps/extension/icons/icon-128.svg — the peeking head over a
 * green fence. Geometry values are copied verbatim from the source SVG.
 */
export const KibitzerLogo: React.FC<{ size: number; title?: string }> = ({ size, title = "Kibitzer" }) => (
  <svg width={size} height={size} viewBox="0 0 128 128" role="img" aria-label={title}>
    <circle cx="64" cy="50" r="50" fill="#1F2937" />
    <circle cx="45" cy="36" r="12.5" fill="#F9FAFB" />
    <circle cx="83" cy="36" r="12.5" fill="#F9FAFB" />
    <rect x="0" y="52" width="128" height="58" rx="9" fill="#F9FAFB" />
    <rect x="4" y="56" width="120" height="50" rx="6" fill="#10B981" />
    <rect x="57" y="106" width="14" height="13" fill="#10B981" />
    <rect x="44" y="118" width="40" height="10" rx="3" fill="#10B981" />
    <rect x="11.5" y="48" width="23" height="20" rx="10" fill="#1F2937" />
    <rect x="93.5" y="48" width="23" height="20" rx="10" fill="#1F2937" />
  </svg>
);
