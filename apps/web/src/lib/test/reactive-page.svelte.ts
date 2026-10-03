// Story 68.7: a reactive stand-in for `$app/state`'s `page` in unit tests. SvelteKit replaces
// `page.url` on a client navigation and `page.data` after `update()`/`invalidateAll()`; assigning
// these fields here re-runs the same `$derived`s a real navigation or locale switch would.
export const reactivePage = $state({
  url: new URL('http://localhost/dashboard'),
  data: {} as Record<string, unknown>,
  params: {} as Record<string, string>,
  route: { id: null as string | null },
  status: 200,
  error: null as { message: string } | null,
  form: null as unknown,
  state: {} as Record<string, unknown>,
})
