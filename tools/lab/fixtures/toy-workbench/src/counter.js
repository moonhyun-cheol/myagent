/** Tiny demo module for coding-plane mutate chains. */
export function bump(n) {
  const v = Number(n) || 0;
  return v + 1;
}

export function label(n) {
  return `count=${bump(n)}`;
}
