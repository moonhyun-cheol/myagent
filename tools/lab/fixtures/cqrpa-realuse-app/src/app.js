import { sum } from './lib/math.js';

function $(id) {
  return document.getElementById(id);
}

function boot() {
  const title = $('title');
  const status = $('status');
  const result = $('result');
  const calc = $('calc');
  if (!status || !result || !calc) {
    console.error('missing DOM ids');
    return;
  }
  if (title && !title.textContent?.trim()) {
    title.textContent = 'CQRPA Realuse';
  }
  status.textContent = 'ready';
  calc.addEventListener('click', () => {
    const a = Number($('a')?.value ?? 0);
    const b = Number($('b')?.value ?? 0);
    result.textContent = String(sum(a, b));
  });
  // Cold paint once so static smoke can assert id wiring without clicks.
  result.textContent = String(sum(2, 3));
}

boot();
