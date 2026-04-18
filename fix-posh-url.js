const fs = require('fs');
let content = fs.readFileSync('electron/extractors/marketplace.js', 'utf8');
content = content.replace(
  "const linkEl = card.querySelector('a[href*=\"/listing/\"]');",
  "const linkEl = card.querySelector('a[href*=\"/listing/\"]');\n      const listingId = card.querySelector('[data-et-prop-listing_id]')?.getAttribute('data-et-prop-listing_id');"
);
content = content.replace(
  "let url = linkEl?.href || '';",
  "let url = linkEl?.href || '';\n      if (!url && listingId) {\n        url = 'https://poshmark.com/listing/' + title.replace(/[^a-zA-Z0-9]/g, '-') + '-' + listingId;\n      }"
);
fs.writeFileSync('electron/extractors/marketplace.js', content);
