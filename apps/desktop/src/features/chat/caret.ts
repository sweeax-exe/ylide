// Pixel position of a character in a textarea, measured with an invisible
// mirror element that copies the textarea's text layout.

const COPIED = [
  'box-sizing',
  'width',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-style',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-stretch',
  'font-variant',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-indent',
  'text-transform',
  'tab-size',
];

/** Top-left of the character at `index`, relative to the textarea's border box (ignores scrolling). */
export function caretPosition(el: HTMLTextAreaElement, index: number): { top: number; left: number } {
  const style = getComputedStyle(el);
  const mirror = document.createElement('div');
  for (const prop of COPIED) mirror.style.setProperty(prop, style.getPropertyValue(prop));
  Object.assign(mirror.style, { position: 'absolute', top: '0', left: '-9999px', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', overflow: 'hidden' });
  mirror.textContent = el.value.slice(0, index);
  const marker = document.createElement('span');
  marker.textContent = el.value.slice(index) || '.';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const position = { top: marker.offsetTop, left: marker.offsetLeft };
  mirror.remove();
  return position;
}
