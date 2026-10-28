import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRawSnippet } from 'svelte'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import Button from './Button.svelte'
import ChoiceGroup from './ChoiceGroup.svelte'
import Select from './Select.svelte'
import TextField from './TextField.svelte'
import Textarea from './Textarea.svelte'
import {
  buttonClass,
  CONTROL_BORDER,
  CONTROL_BORDER_FALLBACK,
  TEXT_CONTROL_CLASS,
} from './control-classes.js'
import { idProblems } from '$lib/test/dom.js'

afterEach(() => cleanup())

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => {
    const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0)
}

describe('control border (D-10)', () => {
  it('is at least 3:1 on white where the old border was 1.48:1', () => {
    const ratio = (hex: string) => 1.05 / (luminance(hex) + 0.05)
    expect(ratio('#cbd5e1')).toBeLessThan(1.5)
    expect(ratio(CONTROL_BORDER_FALLBACK)).toBeGreaterThanOrEqual(3)
  })

  it('reads the M6 border-strong token with the fallback, and the text controls use it', () => {
    expect(CONTROL_BORDER).toContain('--color-border-strong,#64748b')
    expect(TEXT_CONTROL_CLASS).toContain(CONTROL_BORDER)
    expect(TEXT_CONTROL_CLASS).not.toContain('slate-300')
  })
})

describe('Button', () => {
  it('defaults to type=button, content width, md', () => {
    render(Button, { props: { children: textSnippet('Go') } })
    const button = screen.getByRole('button', { name: 'Go' })
    expect(button.getAttribute('type')).toBe('button')
    expect(button.className).not.toContain('w-full')
    expect(button.className).toBe(buttonClass('md', 'primary', false))
  })

  it("primary md is today's class string byte for byte", () => {
    expect(buttonClass('md', 'primary', false)).toBe(
      'rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60'
    )
  })

  it.each([
    ['sm', 'px-3 py-1.5 text-sm'],
    ['lg', 'px-5 py-3 text-lg'],
  ] as const)('size %s', (size, tokens) => {
    expect(buttonClass(size, 'primary', false)).toContain(tokens)
  })

  it('fullWidth, disabled and click', async () => {
    const onclick = vi.fn()
    render(Button, {
      props: { fullWidth: true, onclick, type: 'submit', children: textSnippet('Save') },
    })
    const button = screen.getByRole('button', { name: 'Save' })
    expect(button.className).toContain('w-full')
    expect(button.getAttribute('type')).toBe('submit')
    await fireEvent.click(button)
    expect(onclick).toHaveBeenCalledOnce()
  })

  it('a disabled button is disabled for assistive technology too', () => {
    render(Button, { props: { disabled: true, children: textSnippet('No') } })
    expect((screen.getByRole('button', { name: 'No' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('Field wiring through TextField', () => {
  it('names the control and describes it with the hint', () => {
    render(TextField, { props: { id: 'f1', label: 'Email', hint: 'Use your work email.' } })
    const input = screen.getByRole('textbox', { name: 'Email' })
    expect(input.id).toBe('f1')
    expect(input.getAttribute('aria-describedby')).toBe('f1-help')
    expect(input.hasAttribute('aria-invalid')).toBe(false)
    expect(document.getElementById('f1-help')?.textContent).toBe('Use your work email.')
  })

  it('error comes first, is announced and marks the control invalid', () => {
    render(TextField, { props: { id: 'f2', label: 'Name', hint: 'Hint', error: 'Required' } })
    const input = screen.getByRole('textbox', { name: 'Name' })
    expect(input.getAttribute('aria-describedby')).toBe('f2-error f2-help')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toBe('Required')
  })

  it('renders no aria-describedby without a hint or an error', () => {
    render(TextField, { props: { id: 'f3', label: 'Plain' } })
    expect(screen.getByRole('textbox', { name: 'Plain' }).hasAttribute('aria-describedby')).toBe(
      false
    )
  })

  it('helpId overrides the default help id', () => {
    render(TextField, { props: { id: 'f4', label: 'X', hint: 'h', helpId: 'custom-help' } })
    expect(screen.getByRole('textbox').getAttribute('aria-describedby')).toBe('custom-help')
  })

  it('passes type, autocomplete and required through, and binds typing', async () => {
    render(TextField, {
      props: {
        id: 'f5',
        label: 'Secret',
        type: 'password',
        autocomplete: 'current-password',
        required: true,
      },
    })
    const input = screen.getByLabelText('Secret') as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.autocomplete).toBe('current-password')
    expect(input.required).toBe(true)
    await fireEvent.input(input, { target: { value: 'abc' } })
    expect(input.value).toBe('abc')
  })

  it('has no repeated ids or dangling describedby', () => {
    const { container } = render(TextField, {
      props: { id: 'f6', label: 'L', hint: 'h', error: 'e' },
    })
    expect(idProblems(container)).toEqual([])
  })
})

describe('Textarea and Select', () => {
  it('Textarea is named, described and sized', () => {
    render(Textarea, { props: { id: 't1', label: 'Notes', hint: 'Optional', rows: 6 } })
    const area = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement
    expect(area.rows).toBe(6)
    expect(area.getAttribute('aria-describedby')).toBe('t1-help')
  })

  it('Select lists options, an opt-in placeholder and disabled options', () => {
    render(Select, {
      props: {
        id: 's1',
        label: 'Role',
        placeholder: 'Choose',
        options: [
          { value: 'a', label: 'Admin' },
          { value: 'b', label: 'Member', disabled: true },
        ],
      },
    })
    const select = screen.getByRole('combobox', { name: 'Role' }) as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual(['Choose', 'Admin', 'Member'])
    expect(select.options[2]?.disabled).toBe(true)
  })

  it('Select has no placeholder option unless asked', () => {
    render(Select, { props: { id: 's2', label: 'R', options: [{ value: 'a', label: 'A' }] } })
    expect((screen.getByRole('combobox') as HTMLSelectElement).options).toHaveLength(1)
  })
})

describe('ChoiceGroup', () => {
  const options = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' },
  ]

  it('radio: a named group, one value at a time', async () => {
    render(ChoiceGroup, {
      props: {
        id: 'g1',
        legend: 'Mode',
        type: 'radio',
        name: 'mode',
        options,
        value: 'a',
        hint: 'Pick one',
      },
    })
    const group = screen.getByRole('group', { name: 'Mode' })
    expect(group.getAttribute('aria-describedby')).toBe('g1-help')
    const alpha = screen.getByRole('radio', { name: 'Alpha' }) as HTMLInputElement
    const beta = screen.getByRole('radio', { name: 'Beta' }) as HTMLInputElement
    expect(alpha.checked).toBe(true)
    await fireEvent.click(beta)
    expect(beta.checked).toBe(true)
    expect(alpha.checked).toBe(false)
  })

  it('checkbox: collects several values', async () => {
    render(ChoiceGroup, {
      props: { id: 'g2', legend: 'Pick', type: 'checkbox', name: 'pick', options, value: [] },
    })
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }))
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Beta' }))
    expect((screen.getByRole('checkbox', { name: 'Alpha' }) as HTMLInputElement).checked).toBe(true)
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }))
    expect((screen.getByRole('checkbox', { name: 'Alpha' }) as HTMLInputElement).checked).toBe(
      false
    )
    expect((screen.getByRole('checkbox', { name: 'Beta' }) as HTMLInputElement).checked).toBe(true)
  })

  it('describes the fieldset with the error first and uses unique item ids', () => {
    const { container } = render(ChoiceGroup, {
      props: { id: 'g3', legend: 'L', type: 'radio', name: 'n', options, hint: 'h', error: 'Bad' },
    })
    expect(screen.getByRole('group').getAttribute('aria-describedby')).toBe('g3-error g3-help')
    expect(screen.getByRole('alert').textContent).toBe('Bad')
    expect(idProblems(container)).toEqual([])
  })
})

function textSnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<span>${text}</span>` }))
}
