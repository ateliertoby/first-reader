// Shared HTML-to-plaintext extraction for email bodies.
// Strip order is load-bearing: tags -> entity decode -> invisible chars.
// Decoding entities before tag strip would create false tags from user content.

const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"
};

// Zero-width and invisible Unicode codepoints commonly injected by email
// templates as anti-scraping walls or tracking artifacts.
// U+200B-200F  zero-width space/joiners, directional marks
// U+FEFF       BOM / zero-width no-break space
// U+00AD       soft hyphen
// U+2060       word joiner
// U+034F       combining grapheme joiner
// U+202A-202E  directional formatting
const INVISIBLES = /[​-‏﻿­⁠͏‪-‮]/g;

export function htmlToText(content, contentType) {
  let text = content || '';

  if (contentType === 'html') {
    text = text.replace(/<[^>]+>/g, '');
  }

  // Decode numeric entities (decimal then hex). Out-of-range codepoints in
  // crafted entities decode to nothing — fromCodePoint would throw, and email
  // content must never be able to abort a sort/report run.
  text = text.replace(/&#(\d+);/g, (_, n) => {
    const cp = Number(n);
    return cp <= 0x10FFFF ? String.fromCodePoint(cp) : '';
  });
  text = text.replace(/&#x([0-9a-fA-F]+);/gi, (_, h) => {
    const cp = parseInt(h, 16);
    return cp <= 0x10FFFF ? String.fromCodePoint(cp) : '';
  });

  // Decode named entities (minimal set covering email templates)
  text = text.replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (_, name) => NAMED_ENTITIES[name.toLowerCase()]);

  // Strip invisible chars -- covers both literal chars in source and chars
  // produced by entity decode above (e.g. &#65279; -> U+FEFF)
  text = text.replace(INVISIBLES, '');

  return text.replace(/\s+/g, ' ').trim();
}
