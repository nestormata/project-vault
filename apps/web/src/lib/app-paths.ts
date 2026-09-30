import type { Pathname } from '$app/types'

// Story 68.1 (C1): types for component `href` props that the component passes to `resolve()`
// from `$app/paths`.
//
// Why not plain `Pathname`: `resolve()`'s parameter type (`ResolveArgs<T>`) is a distributive
// conditional type, so an argument typed as the whole `Pathname` union (~70 members) becomes a
// union of one-element tuples, and TypeScript cannot assign a union-typed argument to it (it only
// relates a union argument to a union of tuples member-by-member for small unions). A
// `Pathname`-typed prop therefore cannot be passed to `resolve()` without a cast. These narrower
// types are subsets of `Pathname` that `resolve()` accepts, so a typo such as `'/projetcs'` still
// fails the type check.

/** The projects list or any path under a project (`/projects/<id>/...`), optionally with a query. */
export type ProjectPath = '/projects' | `/projects/${string}`

/** One of the platform-operator pages (`/platform`, `/platform/settings`, ...). */
export type PlatformPath = Extract<Pathname, '/platform' | `/platform/${string}`>
