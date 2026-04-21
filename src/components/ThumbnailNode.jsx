import React from 'react';
import { MINIMAP_NODE_COLORS } from '../utils/constants';
import { getFileCategoryInfo, THEME_COLORS } from '../utils/fileDisplayUtils';

/** Strip basic markdown markers so we show raw text in the thumbnail */
function stripMarkdown(str) {
  return (str || '')
    .replace(/!\[.*?\]\(.*?\)/g, '')   // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // [text](url)
    .replace(/#{1,6}\s?/g, '')          // headings
    .replace(/[*_~`>|]/g, '')           // emphasis / code
    .replace(/\n{2,}/g, '\n')           // collapse blank lines
    .trim();
}

/** Try to extract a short domain-or-label string from a LinkNode's data */
function getLinkDisplay(data) {
  const raw = data?.label || data?.url || '';
  try { return new URL(raw).hostname.replace(/^www\./, ''); } catch { return raw; }
}

/**
 * Node renderer for the thumbnail SVG.
 * - text nodes: white SVG text lines (first 3, stripped of markdown)
 * - link nodes: muted blue background + domain/label text
 * - all others: solid-color rectangle (minimap palette)
 */
export function ThumbnailNode({ r }) {
  const { x, y, w, h, type, data } = r;

  if (type === 'text') {
    const lines = stripMarkdown(data?.text)
      .split('\n')
      .filter(l => l.trim())
      .slice(0, 4);

    const lineH    = Math.min(h / (lines.length || 1), 14);
    const fontSize = Math.max(7, Math.min(11, lineH * 0.8));
    // Preserve user-chosen color and font family; fall back to sensible defaults
    const textFill = data?.textColor || (data?.isSticky ? 'rgba(30,30,30,0.85)' : 'rgba(255,255,255,0.70)');
    const bgFill = data?.backgroundColor === 'transparent' ? 'transparent' : (data?.backgroundColor || (data?.isSticky ? '#fef08a' : 'rgba(255,255,255,0.05)'));
    const fontFam  = data?.fontFamily || 'Inter, ui-sans-serif, sans-serif';

    return (
      <g>
        <rect x={x} y={y} width={w} height={h} rx={4} fill={bgFill} />
        {lines.length === 0 ? (
          <text x={x + 6} y={y + 14} fontSize={fontSize}
            fill="rgba(255,255,255,0.2)" fontFamily={fontFam}>
            (empty)
          </text>
        ) : lines.map((line, i) => {
          const maxChars = Math.floor(w / (fontSize * 0.55));
          const display = line.length > maxChars ? line.slice(0, maxChars - 1) + '…' : line;
          return (
            <text
              key={i}
              x={x + 6}
              y={y + (i + 1) * lineH - 2}
              fontSize={fontSize}
              fill={textFill}
              fontFamily={fontFam}
            >
              {display}
            </text>
          );
        })}
      </g>
    );
  }

  if (type === 'link') {
    const display  = getLinkDisplay(data);
    const maxChars = Math.floor(w / 8);
    const label    = display.length > maxChars ? display.slice(0, maxChars - 1) + '…' : display;
    const linkFill = data?.textColor || 'rgba(96,165,250,0.75)';
    const bgFill = data?.backgroundColor === 'transparent' ? 'transparent' : (data?.backgroundColor || 'rgba(96,165,250,0.07)');
    const fontFam  = data?.fontFamily || 'Inter, ui-sans-serif, sans-serif';

    return (
      <g>
        <rect x={x} y={y} width={w} height={h} rx={4} fill={bgFill}
          stroke="rgba(96,165,250,0.20)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <text x={x + 7} y={y + h / 2 + 4} fontSize={9}
          fill={linkFill} fontFamily={fontFam}>
          ↗ {label || '—'}
        </text>
      </g>
    );
  }

  if (type === 'group') {
    const radius = Math.min(w, h) / 2;
    const cx = x + w / 2;
    const cy = y + h / 2;
    // Scale font to the thumbnail circle size; preserve user's color/family choices
    const titleColor  = data?.textColor  || 'rgba(255,255,255,0.60)';
    const bgFill = data?.backgroundColor === 'transparent' ? 'transparent' : (data?.backgroundColor || 'rgba(96,165,250,0.06)');
    const titleFamily = data?.fontFamily || 'Inter, ui-sans-serif, sans-serif';
    const fs = Math.max(4, Math.min(radius * 0.28, 9));
    const maxChars = radius > 0 ? Math.max(4, Math.floor((radius * 1.8) / (fs * 0.6))) : 8;
    return (
      <g>
        <circle cx={cx} cy={cy} r={radius}
          fill={bgFill}
          stroke="rgba(96,165,250,0.45)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
        {data?.title && radius > 10 && (
          <text
            x={cx} y={cy}
            fontSize={fs}
            fill={titleColor}
            fontFamily={titleFamily}
            fontWeight="500"
            textAnchor="middle"
            dominantBaseline="middle"
            style={{ pointerEvents: 'none' }}
          >
            {data.title.length > maxChars ? data.title.slice(0, maxChars - 1) + '…' : data.title}
          </text>
        )}
      </g>
    );
  }

  if (type === 'document') {
    const { category, label, color, badge, Icon } = getFileCategoryInfo(data?.filename);
    const theme = THEME_COLORS[color];
    const bgFill = data?.backgroundColor === 'transparent' ? 'transparent' : (data?.backgroundColor || 'rgba(24,24,27,0.85)');

    const isImage = category === 'image';
    if (isImage && data?.filePath) {
      const imgSrc = `local-file://${data.filePath.replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
      return (
        <g>
          <rect x={x} y={y} width={w} height={h} rx={6} fill={bgFill} stroke="rgba(255,255,255,0.1)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <image href={imgSrc} x={x + 4} y={y + 4} width={Math.max(0, w - 8)} height={Math.max(0, h - 8)} preserveAspectRatio="xMidYMid meet" />
        </g>
      );
    }

    const name = data?.filename || 'Unknown File';
    const maxChars = w > 0 ? Math.floor(w / 6) : 0;
    const display = maxChars > 1 && name.length > maxChars ? name.slice(0, maxChars - 1) + '…' : name;
    
    const iconS = Math.min(32, h * 0.5); 
    const pad = Math.min(12, h * 0.15); 
    const fontS1 = Math.max(6, Math.min(12, h * 0.22));
    const fontS2 = Math.max(5, Math.min(10, h * 0.18));
    const textFill = data?.textColor || 'rgba(255,255,255,0.9)';
    
    return (
      <g>
        <rect x={x} y={y} width={w} height={h} rx={12} fill={bgFill} stroke="rgba(255,255,255,0.08)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        
        {w > iconS + pad * 2 && h > iconS && (
          <g transform={`translate(${x + pad}, ${y + (h - iconS) / 2})`}>
            <rect x={0} y={0} width={iconS} height={iconS} rx={8} fill={`rgba(${theme.rgb}, 0.15)`} />
            <g transform={`translate(${iconS * 0.25}, ${iconS * 0.25})`} style={{ pointerEvents: 'none' }}>
              <Icon width={iconS * 0.5} height={iconS * 0.5} color={`rgba(${theme.rgb}, 0.9)`} strokeWidth={1.5} />
            </g>
          </g>
        )}
        
        {w > iconS + pad * 3 && h > fontS1 + fontS2 + pad && (
          <g>
            <text x={x + iconS + pad * 2} y={y + h/2 - Math.max(2, h*0.02)} fontSize={fontS1} fill={textFill} fontFamily="sans-serif" fontWeight="500">
              {display}
            </text>
            <text x={x + iconS + pad * 2} y={y + h/2 + fontS2 + Math.max(2, h*0.02)} fontSize={fontS2} fill="rgba(156,163,175,0.8)" fontFamily="sans-serif">
              {label}
            </text>
            
            {/* Inline badge for quick extension scanning in thumbnail */}
            {w > iconS + pad * 3 + fontS1 * display.length * 0.6 + 30 && (
              <g transform={`translate(${x + w - pad - badge.length * fontS2 * 0.8}, ${y + pad})`}>
                <rect x={-4} y={-fontS2} width={badge.length * fontS2 * 0.8 + 8} height={fontS2 * 1.5} rx={2} fill={`rgba(${theme.rgb}, 0.2)`} />
                <text x={0} y={fontS2 * 0.15} fontSize={fontS2 * 0.8} fill={`rgba(${theme.rgb}, 0.9)`} fontFamily="sans-serif" fontWeight="bold">
                  {badge}
                </text>
              </g>
            )}
          </g>
        )}
      </g>
    );
  }

  // All other node types: solid rectangle (minimap palette)
  let bgColor = MINIMAP_NODE_COLORS[type] || '#555';
  if (data?.backgroundColor && data.backgroundColor !== 'transparent') {
    bgColor = data.backgroundColor;
  }
  const textFill = data?.textColor || 'rgba(255,255,255,0.9)';
  const labelText = data?.label || data?.title || type || 'Node';
  const maxChars = w > 0 ? Math.floor(w / 4 + 2) : 0;
  const display = maxChars > 1 && labelText.length > maxChars ? labelText.slice(0, maxChars - 1) + '…' : labelText;
  const fs = Math.max(4, Math.min(8, h * 0.3));

  return (
    <g>
      <rect
        x={x} y={y} width={w} height={h}
        rx={6} ry={6}
        fill={bgColor}
        opacity={0.85}
      />
      {w > fs * 3 && h > fs + 4 && (
        <text
          x={x + w/2} y={y + h/2}
          fontSize={fs}
          fill={textFill}
          fontFamily="sans-serif"
          fontWeight="500"
          textAnchor="middle"
          dominantBaseline="middle"
          style={{ pointerEvents: 'none' }}
        >
          {display}
        </text>
      )}
    </g>
  );
}
