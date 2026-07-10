import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/svelte'
import DashboardPlaceholderGrid from './DashboardPlaceholderGrid.svelte'

describe('DashboardPlaceholderGrid (AC-G1, AC-G2)', () => {
  afterEach(() => cleanup())

  it('AC-G2 regression: with no props (both default false), all 4 category cards render', () => {
    render(DashboardPlaceholderGrid)

    expect(screen.getByText('Credentials')).toBeTruthy()
    expect(screen.getByText('Certificates and domains')).toBeTruthy()
    expect(screen.getByText('Services and health')).toBeTruthy()
    expect(screen.getByText('Alerts')).toBeTruthy()
    expect(screen.getByText('Coverage gaps')).toBeTruthy()
  })

  it('AC-G1 positive (fully populated): hasCredentials/hasServices true suppresses only those 2 cards; Certs/Alerts remain', () => {
    render(DashboardPlaceholderGrid, { props: { hasCredentials: true, hasServices: true } })

    expect(screen.queryByText('Credentials')).toBeNull()
    expect(screen.queryByText('Services and health')).toBeNull()
    expect(screen.getByText('Certificates and domains')).toBeTruthy()
    expect(screen.getByText('Alerts')).toBeTruthy()
    expect(screen.getByText('Coverage gaps')).toBeTruthy()
  })

  it('AC-G1 edge (partial coverage): hasCredentials true, hasServices false suppresses only the Credentials card', () => {
    render(DashboardPlaceholderGrid, { props: { hasCredentials: true, hasServices: false } })

    expect(screen.queryByText('Credentials')).toBeNull()
    expect(screen.getByText('Services and health')).toBeTruthy()
    expect(screen.getByText('Certificates and domains')).toBeTruthy()
    expect(screen.getByText('Alerts')).toBeTruthy()
  })

  it('AC-G1: the Coverage-gaps card no longer claims stale "Story 2.1" / "no operational assets" copy', () => {
    render(DashboardPlaceholderGrid, { props: { hasCredentials: true, hasServices: true } })

    expect(screen.queryByText(/Story 2\.1/)).toBeNull()
    expect(screen.queryByText(/no operational assets have been added yet/)).toBeNull()
    expect(
      screen.getByText(
        "Certificate, domain, and alert coverage for this project aren't tracked in this dashboard yet."
      )
    ).toBeTruthy()
  })
})
