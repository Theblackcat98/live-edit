import type { ToolDefinition, ToolName } from '../types'

export const TOOL_DEFS: ToolDefinition[] = [
  {
    name: 'add_text',
    description:
      'Insert new text or Markdown at a precise position: append, prepend, after a line, or under a heading.',
    params: [
      { name: 'file_path', type: 'string', required: true, description: 'Target note path.' },
      {
        name: 'position',
        type: 'enum: append | prepend | after_line | under_heading',
        required: true,
        description: 'Where the content is inserted.',
      },
      {
        name: 'anchor',
        type: 'string | integer',
        required: false,
        description: 'Line number or exact heading supplied by the supervisor.',
      },
      { name: 'content', type: 'string', required: true, description: 'Markdown to insert.' },
    ],
  },
  {
    name: 'edit_text',
    description:
      'Replace a grounded line span with updated text. The old anchor must match the current note.',
    params: [
      { name: 'file_path', type: 'string', required: true, description: 'Target note path.' },
      { name: 'start_line', type: 'integer', required: true, description: '1-based first line.' },
      { name: 'end_line', type: 'integer', required: true, description: '1-based last line.' },
      {
        name: 'old_text_anchor',
        type: 'string',
        required: true,
        description: 'Exact text currently in the target span.',
      },
      { name: 'new_text', type: 'string', required: true, description: 'Replacement text.' },
    ],
  },
  {
    name: 'remove_text',
    description:
      'Delete a grounded line span, bullet, row or section after the critic verifies the target.',
    params: [
      { name: 'file_path', type: 'string', required: true, description: 'Target note path.' },
      { name: 'start_line', type: 'integer', required: true, description: '1-based first line.' },
      { name: 'end_line', type: 'integer', required: true, description: '1-based last line.' },
      {
        name: 'target_excerpt',
        type: 'string',
        required: true,
        description: 'Confirmation snippet of the text being removed.',
      },
    ],
  },
]

export const TOOL_BY_NAME = Object.fromEntries(
  TOOL_DEFS.map((definition) => [definition.name, definition]),
) as Record<ToolName, ToolDefinition>

export const TOOL_LABELS: Record<ToolName, string> = {
  add_text: 'Add text',
  edit_text: 'Edit text',
  remove_text: 'Remove text',
}
