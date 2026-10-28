/**
 * Builds ALL contenders first, then releases them at once on a barrier.
 * Creating and awaiting in a loop serialises the "race" and proves nothing.
 */
export async function race<T>(n: number, make: (i: number) => () => Promise<T>): Promise<T[]> {
  const contenders = Array.from({ length: n }, (_, i) => make(i));
  let release!: () => void;
  const barrier = new Promise<void>((r) => (release = r));
  const running = contenders.map((fn) => barrier.then(fn));
  release();
  return Promise.all(running);
}
