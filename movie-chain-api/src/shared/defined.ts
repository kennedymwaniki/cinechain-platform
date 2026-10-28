/**
 * Drops keys whose value is `undefined`. Turns a validated PATCH body into a
 * patch object under exactOptionalPropertyTypes, where `{ x: undefined }` and
 * `{}` are different types (and only the latter means "leave x alone").
 */
export function definedOnly<T extends Record<string, unknown>>(obj: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
