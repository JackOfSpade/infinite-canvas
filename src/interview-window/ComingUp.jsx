import React from 'react';

export default function ComingUp({ preview, children }) {
  if (!preview) return null;
  return <section className="coming-up" aria-label="Coming up">
    <p className="preview-label">Coming up · Likely {Math.round(preview.confidence * 100)}%</p>
    <div className="coming-up-scroll" tabIndex={0} aria-label="Upcoming prepared answer">
      <div className="coming-up-content" key={preview.cardId}>
        <h2>{preview.card.headline}</h2>
        <ul>{preview.card.bullets.map((bullet, index) => <li key={index}>{bullet.text}</li>)}</ul>
      </div>
      <details className="preview-full-card">
        <summary>Full prepared answer</summary>
        {children}
      </details>
    </div>
  </section>;
}
