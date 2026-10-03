// Story 68.7 AC-7/AC-14: deep-freezes plain data (objects and arrays). Functions and Svelte
// components inside it are left as they are (freezing a component would break hot reloading).
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}
