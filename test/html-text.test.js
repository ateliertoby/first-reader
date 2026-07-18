import { test, describe } from 'node:test';
import assert from 'node:assert';
import { htmlToText } from '../src/sorter/html-text.js';

describe('htmlToText', () => {
  test('strips HTML tags for html contentType', () => {
    assert.strictEqual(
      htmlToText('<p>hello</p> <b>world</b>', 'html'),
      'hello world'
    );
  });

  test('skips tag strip for text contentType', () => {
    assert.strictEqual(
      htmlToText('<p>hello</p>', 'text'),
      '<p>hello</p>'
    );
  });

  test('strips literal zero-width chars (U+200B-U+200F)', () => {
    assert.strictEqual(
      htmlToText('hello​‌‍‎‏world', 'text'),
      'helloworld'
    );
  });

  test('strips literal FEFF (BOM)', () => {
    assert.strictEqual(
      htmlToText('hello﻿world', 'text'),
      'helloworld'
    );
  });

  test('strips literal soft hyphen (U+00AD)', () => {
    assert.strictEqual(
      htmlToText('hello­world', 'text'),
      'helloworld'
    );
  });

  test('strips literal word joiner (U+2060)', () => {
    assert.strictEqual(
      htmlToText('hello⁠world', 'text'),
      'helloworld'
    );
  });

  test('strips literal combining grapheme joiner (U+034F)', () => {
    assert.strictEqual(
      htmlToText('hello͏world', 'text'),
      'helloworld'
    );
  });

  test('strips literal directional formatting (U+202A-U+202E)', () => {
    assert.strictEqual(
      htmlToText('hello‪‫‬‭‮world', 'text'),
      'helloworld'
    );
  });

  test('decodes decimal numeric entities then strips resulting invisibles', () => {
    // &#65279; = U+FEFF, &#8203; = U+200B
    assert.strictEqual(
      htmlToText('hello&#65279;&#8203;world', 'text'),
      'helloworld'
    );
  });

  test('decodes hex numeric entities then strips resulting invisibles', () => {
    // &#xFEFF; = U+FEFF, &#x200B; = U+200B
    assert.strictEqual(
      htmlToText('hello&#xFEFF;&#x200B;world', 'text'),
      'helloworld'
    );
  });

  test('decodes named entities: &nbsp; &amp; &lt; &gt; &quot; &apos;', () => {
    assert.strictEqual(
      htmlToText('a&nbsp;b&amp;c&lt;d&gt;e&quot;f&apos;g', 'text'),
      'a b&c<d>e"f\'g'
    );
  });

  test('collapses whitespace and trims', () => {
    assert.strictEqual(
      htmlToText('  hello   world  \n\t end  ', 'text'),
      'hello world end'
    );
  });

  test('handles null/undefined content', () => {
    assert.strictEqual(htmlToText(null, 'html'), '');
    assert.strictEqual(htmlToText(undefined, 'text'), '');
  });

  test('fal.ai wall scenario: mixed literal + entity zero-width chars before real content', () => {
    // Simulate the real fal.ai email: ~100 literal ZW chars + entity-encoded ones + real content
    const literalWall = '​‌‍‎‏'.repeat(20);
    const entityWall = '&#65279;'.repeat(30) + '&#x200B;'.repeat(20);
    const realContent = '<div>' + literalWall + entityWall + 'Order Confirmation Hi Alex Chan! You have successfully added $10.00 to your balance.</div>';
    const result = htmlToText(realContent, 'html');
    assert.strictEqual(result, 'Order Confirmation Hi Alex Chan! You have successfully added $10.00 to your balance.');
  });

  test('tag strip before entity decode prevents false tags from decoded content', () => {
    // If we decoded first, &#60; -> < could create a false tag <b>
    const input = '<p>&#60;b&#62;not bold&#60;/b&#62;</p>';
    const result = htmlToText(input, 'html');
    assert.strictEqual(result, '<b>not bold</b>');
  });
});

test('out-of-range numeric entities decode to nothing without throwing', () => {
  const out = htmlToText('before &#999999999999; middle &#x110000; after', 'text');
  assert.strictEqual(out, 'before middle after');
});
