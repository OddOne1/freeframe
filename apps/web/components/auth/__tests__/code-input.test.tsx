/**
 * The six-digit code boxes: behaviour, pinned before a layout change (§201).
 *
 * §201 regrouped these boxes — centred as one tight cluster with the usual
 * `123 456` break — and the risk in that change is not visual. Paste-fill,
 * auto-advance and backspace-to-previous all index a single flat array of six
 * refs, and the obvious way to draw a gap after the third box (two nested flex
 * containers) silently breaks that indexing: box 4 stops receiving focus, and
 * a pasted code lands in three boxes instead of six.
 *
 * None of this had a test. `login-form-2fa.test.tsx` and the gate's own tests
 * drive the boxes one digit at a time through `userEvent.type`, which never
 * exercises the paste handler at all — so the one behaviour most likely to
 * break here was the one nothing was watching. These tests exist to make the
 * §201 layout change verified rather than merely reasoned about, and they are
 * about the component's contract, not its appearance: nothing below asserts a
 * class name or a pixel.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { CodeInput, EMPTY_CODE } from '@/components/auth/code-input'

/** A controlled host, because CodeInput deliberately does not own its digits
 *  — the parent has to be able to clear them after a rejected code. Testing
 *  it uncontrolled would test a component this app never renders. */
function Harness({ onComplete }: { onComplete?: (code: string) => void }) {
  const [value, setValue] = useState<string[]>(EMPTY_CODE)
  return (
    <CodeInput value={value} onChange={setValue} onComplete={onComplete ?? (() => {})} />
  )
}

const boxes = () => screen.getAllByLabelText(/^digit /i) as HTMLInputElement[]

function paste(target: HTMLElement, text: string) {
  // `userEvent.paste` needs a clipboard the jsdom environment does not have,
  // so the ClipboardEvent is dispatched directly. `getData` is what the
  // handler actually calls, which is the part worth simulating faithfully.
  fireEvent.paste(target, { clipboardData: { getData: () => text } })
}

describe('paste', () => {
  it('fills all six boxes from a pasted code', () => {
    render(<Harness />)
    paste(boxes()[0], '123456')

    expect(boxes().map((b) => b.value)).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it('submits the pasted code without waiting for a re-render', () => {
    // The original reason this handler passes `pasted` to onComplete rather
    // than reading state: the state it would read has not updated yet.
    const onComplete = vi.fn()
    render(<Harness onComplete={onComplete} />)
    paste(boxes()[0], '123456')

    expect(onComplete).toHaveBeenCalledWith('123456')
  })

  it('strips non-digits and takes the first six', () => {
    render(<Harness />)
    paste(boxes()[0], 'code: 12-34-56-78')

    expect(boxes().map((b) => b.value)).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it('does not submit a short paste', () => {
    const onComplete = vi.fn()
    render(<Harness onComplete={onComplete} />)
    paste(boxes()[0], '123')

    expect(boxes().map((b) => b.value)).toEqual(['1', '2', '3', '', '', ''])
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('fills from the start even when pasted into a later box', () => {
    // A code belongs to the whole group, not to the box that happened to have
    // focus. Someone clicking box 4 and hitting paste means the same thing as
    // clicking box 1.
    render(<Harness />)
    paste(boxes()[4], '987654')

    expect(boxes().map((b) => b.value)).toEqual(['9', '8', '7', '6', '5', '4'])
  })
})

describe('typing', () => {
  it('advances across the 123 456 break', async () => {
    // Box 4 is where §201 put the wider gap. If that gap had been drawn by
    // splitting the row into two containers, focus would stop here.
    render(<Harness />)
    await userEvent.type(boxes()[2], '3')

    expect(document.activeElement).toBe(boxes()[3])
  })

  it('advances box by box and submits on the sixth digit', async () => {
    const onComplete = vi.fn()
    render(<Harness onComplete={onComplete} />)
    for (let i = 0; i < 6; i++) {
      await userEvent.type(boxes()[i], `${i + 1}`)
    }

    expect(boxes().map((b) => b.value)).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(onComplete).toHaveBeenCalledWith('123456')
  })

  it('ignores a keystroke into a box that is already full', async () => {
    // Measured, not assumed: `maxLength={1}` rejects the character before
    // onChange ever fires, so the box keeps what it had. Correcting a digit
    // means backspacing onto it first, which is how every OTP field behaves.
    render(<Harness />)
    await userEvent.type(boxes()[0], '1')
    await userEvent.type(boxes()[0], '9')

    expect(boxes()[0].value).toBe('1')
  })

  it('takes the last digit when a value arrives longer than one character', () => {
    // What `.slice(-1)` in handleChange is actually for. maxLength stops this
    // from a normal keystroke, but a software keyboard or an IME can commit a
    // longer string in one change event — and without the slice the box would
    // be handed two characters and render neither correctly.
    render(<Harness />)
    fireEvent.change(boxes()[0], { target: { value: '19' } })

    expect(boxes()[0].value).toBe('9')
  })
})

describe('backspace', () => {
  it('moves to the previous box when the current one is empty', async () => {
    render(<Harness />)
    await userEvent.type(boxes()[0], '1')
    await userEvent.type(boxes()[1], '{backspace}')

    expect(document.activeElement).toBe(boxes()[0])
  })

  it('stays put on the first box', async () => {
    render(<Harness />)
    boxes()[0].focus()
    await userEvent.keyboard('{backspace}')

    expect(document.activeElement).toBe(boxes()[0])
  })
})

describe('structure', () => {
  it('renders exactly six boxes in ONE row', () => {
    // The invariant the `123 456` gap could have broken. Two containers would
    // still render six inputs and still look right — and would break every
    // behaviour above — so this asserts the shape the handlers depend on
    // rather than trusting the tests above to notice.
    render(<Harness />)
    const all = boxes()
    expect(all).toHaveLength(6)

    const parents = new Set(all.map((b) => b.parentElement))
    expect(parents.size).toBe(1)
  })
})
