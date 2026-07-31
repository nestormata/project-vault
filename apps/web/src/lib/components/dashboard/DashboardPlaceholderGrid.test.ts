import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/svelte'
import DashboardPlaceholderGrid from './DashboardPlaceholderGrid.svelte'

describe('DashboardPlaceholderGrid (Story 18.12)', () => {
  afterEach(() => cleanup())

  it('AC-G2 regression: with no props (both default false), the project coverage cards render', () => {
    render(DashboardPlaceholderGrid)

    expect(screen.getByText('Credentials')).toBeTruthy()
    expect(screen.getByText('Certificates and domains')).toBeTruthy()
    expect(screen.getByText('Services and health')).toBeTruthy()
    expect(screen.getByText('Coverage gaps')).toBeTruthy()
    expect(screen.queryByText('Alerts', { selector: 'h2' })).toBeNull()
  })

  it('AC-1/AC-3: real certificate and domain counts replace the stale placeholder copy', () => {
    render(DashboardPlaceholderGrid, {
      props: {
        hasCredentials: true,
        hasServices: true,
        certificates: { status: 'ready', count: 2 },
        domains: { status: 'ready', count: 1 },
      },
    })

    expect(screen.queryByText('Credentials')).toBeNull()
    expect(screen.queryByText('Services and health')).toBeNull()
    expect(screen.getByText('Certificates and domains')).toBeTruthy()
    expect(screen.getByText('2 certificates')).toBeTruthy()
    expect(screen.getByText('1 domain')).toBeTruthy()
    expect(screen.queryByText('No certificate or domain records added yet.')).toBeNull()
    expect(screen.queryByText('No alert sources configured yet.')).toBeNull()
  })

  it('AC-G1 edge (partial coverage): hasCredentials true, hasServices false suppresses only the Credentials card', () => {
    render(DashboardPlaceholderGrid, {
      props: {
        hasCredentials: true,
        hasServices: false,
        certificates: { status: 'ready', count: 0 },
        domains: { status: 'ready', count: 0 },
      },
    })

    expect(screen.queryByText('Credentials')).toBeNull()
    expect(screen.getByText('Services and health')).toBeTruthy()
    expect(screen.getByText('Certificates and domains')).toBeTruthy()
    expect(screen.getByText('No certificate or domain records added yet.')).toBeTruthy()
  })

  it('AC-4/AC-6: empty data has honest copy, while one failed query is independently unavailable', () => {
    render(DashboardPlaceholderGrid, {
      props: {
        certificates: { status: 'error', count: 0 },
        domains: { status: 'ready', count: 2 },
      },
    })

    expect(screen.getByText('Certificates unavailable right now.')).toBeTruthy()
    expect(screen.getByText('2 domains')).toBeTruthy()
    expect(screen.queryByText('No certificate or domain records added yet.')).toBeNull()
  })

  it('AC-5: loading state shows skeleton copy instead of an empty state', () => {
    render(DashboardPlaceholderGrid, {
      props: {
        certificates: { status: 'loading', count: 0 },
        domains: { status: 'loading', count: 0 },
      },
    })

    expect(screen.getByLabelText('Loading certificates')).toBeTruthy()
    expect(screen.getByLabelText('Loading domains')).toBeTruthy()
    expect(screen.queryByText('No certificate or domain records added yet.')).toBeNull()
  })

  it('AC-G1: the Coverage-gaps card no longer claims stale "not tracked" copy', () => {
    render(DashboardPlaceholderGrid, { props: { hasCredentials: true, hasServices: true } })

    expect(screen.queryByText(/not tracked in this dashboard yet/)).toBeNull()
  })
})
