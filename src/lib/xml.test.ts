import { describe, expect, it } from 'vitest'
import { parseToolCallXml } from './xml'

describe('parseToolCallXml case handling', () => {
  it('parses lowercase tool and param names', () => {
    const parsed = parseToolCallXml(
      '<tool_call>\n<function=add_text>\n<parameter=file_path>\nx\n</parameter>\n</function>\n</tool_call>',
    )
    expect(parsed?.name).toBe('add_text')
    expect(parsed?.params.file_path).toBe('x')
  })

  it('normalizes shouted tool and param names (live 1.7B: ADD_TEXT)', () => {
    const parsed = parseToolCallXml(
      '<tool_call>\n<function=ADD_TEXT>\n<parameter=FILE_PATH>\nx\n</parameter>\n<parameter=POSITION>\nappend\n</parameter>\n<parameter=CONTENT>\n- hi\n</parameter>\n</function>\n</tool_call>',
    )
    expect(parsed?.name).toBe('add_text')
    expect(parsed?.params.file_path).toBe('x')
    expect(parsed?.params.position).toBe('append')
    expect(parsed?.params.content).toBe('- hi')
  })

  it('still rejects unknown tools', () => {
    expect(parseToolCallXml('<tool_call><function=write_file></function></tool_call>')).toBeNull()
  })
})
