import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import CronScheduleHelp from './CronScheduleHelp.svelte'

afterEach(() => cleanup())

describe('CronScheduleHelp', () => {
  it('opens an accessible dialog that explains every cron position and closes with Escape', async () => {
    render(CronScheduleHelp)

    const trigger = screen.getByRole('button', { name: /show cron field help/i })
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(screen.queryByRole('dialog')).toBeNull()

    await fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: /cron schedule fields/i })).toBeTruthy()
    expect(screen.getByText(/minute \(0–59\)/i)).toBeTruthy()
    expect(screen.getByText(/hour \(0–23\)/i)).toBeTruthy()
    expect(screen.getByText(/day of month \(1–31\)/i)).toBeTruthy()
    expect(screen.getByText(/month \(1–12\)/i)).toBeTruthy()
    expect(screen.getByText(/weekday \(0–7/i)).toBeTruthy()

    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps keyboard focus inside the modal and uses instance-specific identifiers', async () => {
    render(CronScheduleHelp, { props: { id: 'rotation-schedule' } })
    const trigger = screen.getByRole('button', { name: /show cron field help/i })

    await fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog')
    const close = screen.getByRole('button', { name: /close/i })
    expect(dialog.id).toBe('rotation-schedule-dialog')
    expect(dialog.getAttribute('aria-labelledby')).toBe('rotation-schedule-title')

    close.focus()
    await fireEvent.keyDown(close, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
  })
})
