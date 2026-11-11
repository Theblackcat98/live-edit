import { describe, expect, it } from 'vitest'
import { recoverDictatedText } from './dictation'
import type { Directive } from '../types'

function directive(extra: Partial<Directive> = {}): Directive {
  return { task: 'insert', instruction: 'add the quoted line under Security', ...extra }
}

describe('recoverDictatedText', () => {
  it('recovers the case-8f quoted span from the raw command', () => {
    expect(
      recoverDictatedText(
        'add a line under Security: "rotate production keys monthly starting Monday"',
        directive(),
      ),
    ).toBe('rotate production keys monthly starting Monday')
  })

  it('recovers curly-quoted dictation (ASR/IME keyboards produce these)', () => {
    expect(recoverDictatedText('add a note: “bring the spare cables”', directive())).toBe(
      'bring the spare cables',
    )
  })

  it('stays out of the way when the model populated verbatim itself', () => {
    expect(
      recoverDictatedText('add: "model text"', directive({ verbatim: 'model text' })),
    ).toBeNull()
  })

  it('never treats reference quotes on edit/remove tasks as dictation', () => {
    expect(
      recoverDictatedText('rename the title to "Q3 Review Final"', directive({ task: 'edit' })),
    ).toBeNull()
    expect(
      recoverDictatedText('remove the line "old draft"', directive({ task: 'remove' })),
    ).toBeNull()
  })

  it('recovers a dictated line when an add-line command is mistasked as edit (8f rep-3 shape)', () => {
    // Omni tasked the add-line command as edit with no verbatim; the
    // quoted span is still a dictated line (insertion verb present).
    expect(
      recoverDictatedText(
        'add a line under Security: "rotate production keys monthly starting Monday"',
        directive({ task: 'edit' }),
      ),
    ).toBe('rotate production keys monthly starting Monday')
  })

  it('returns null when there is no quoted span or only trivia', () => {
    expect(recoverDictatedText('add a line about key rotation', directive())).toBeNull()
    expect(recoverDictatedText('add "x" under Security', directive())).toBeNull()
    expect(recoverDictatedText('add "  " under Security', directive())).toBeNull()
  })

  it('applies to create tasks as well as inserts', () => {
    expect(
      recoverDictatedText('start a changelog with "v1 shipped"', directive({ task: 'create' })),
    ).toBe('v1 shipped')
  })
})
