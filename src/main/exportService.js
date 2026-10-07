'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { getFullChatHistory } = require('./sessionManager');

const FORMATS = Object.freeze({
  json: { name: 'JSON', extension: 'json' },
  markdown: { name: 'Markdown', extension: 'md' },
  text: { name: 'Plain Text', extension: 'txt' },
});
function exportFormat(format) {
  if (!Object.hasOwn(FORMATS, format)) throw new Error('Choose JSON, Markdown, or Plain Text.');
  return FORMATS[format];
}
function metadataBlock(value, markdown) {
  const json = JSON.stringify(value, null, 2);
  if (!markdown) return json;
  const longest = Math.max(2, ...(json.match(/`+/g) || []).map(run => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}json\n${json}\n${fence}`;
}

async function plainTextRenderer() {
  const [{ unified }, { default: remarkParse }, { default: remarkGfm }] = await Promise.all([
    import('unified'), import('remark-parse'), import('remark-gfm'),
  ]);
  const parser = unified().use(remarkParse).use(remarkGfm);
  return content => {
    const tree = parser.parse(content);
    const definitions = new Map(tree.children.filter(node => node.type === 'definition').map(node => [node.identifier, node.url]));
    function render(node) {
      if (['text', 'code', 'inlineCode'].includes(node.type)) return node.value;
      if (node.type === 'html') return node.value.replace(/<\/?[a-z][^>]*>/gi, '');
      if (node.type === 'break') return '\n';
      if (node.type === 'thematicBreak' || node.type === 'definition') return '';
      const separator = ['root', 'blockquote', 'listItem'].includes(node.type) ? '\n\n'
        : ['list', 'table'].includes(node.type) ? '\n' : node.type === 'tableRow' ? '\t' : '';
      const text = (node.children || []).map(render).join(separator);
      if (['link', 'image', 'linkReference', 'imageReference'].includes(node.type)) {
        const label = node.alt ?? text;
        const url = node.url ?? definitions.get(node.identifier);
        return url ? (label === url ? url : `${label} (${url})`) : label;
      }
      return text;
    }
    return render(tree).trim();
  };
}

async function formatChatExport({ session, messages }, format) {
  exportFormat(format);
  if (format === 'json') return JSON.stringify(messages, null, 2) + '\n';
  const markdown = format === 'markdown';
  const body = markdown ? value => value : await plainTextRenderer();
  const heading = (level, text) => markdown ? `${'#'.repeat(level)} ${text}` : text;
  const lines = [heading(1, String(session.title || 'Untitled chat').replace(/[\r\n]/g, ' ')),
    'Session metadata:', metadataBlock(session, markdown)];
  if (!messages.length) lines.push('This conversation has no saved messages.');
  for (const message of messages) {
    const { content, variants, ...metadata } = message;
    lines.push(heading(2, `${message.role === 'assistant' ? 'Assistant' : message.role === 'user' ? 'User' : message.role} message ${message.id}`),
      'Message metadata:', metadataBlock(metadata, markdown));
    if (message.role === 'assistant' && Array.isArray(variants) && variants.length) {
      // Keep the selected row content too if it differs from its stored variant.
      const selected = variants[message.active_variant_index ?? 0];
      if ((typeof selected === 'string' ? selected : selected?.content) !== content) {
        lines.push('Stored message content:', body(content || ''));
      }
      variants.forEach((entry, index) => {
        const variant = typeof entry === 'string' ? { content: entry } : entry;
        const { content: variantContent, ...details } = variant && typeof variant === 'object' ? variant : { value: variant };
        const model = details.model_name ?? details.model_id ?? details.model ?? 'Not recorded';
        lines.push(heading(3, `AI Response (Variant ${index + 1}) [Model: ${String(model).replace(/[\r\n]/g, ' ')}]${index === (message.active_variant_index ?? 0) ? ' [Active]' : ''}`),
          'Variant metadata:', metadataBlock(details, markdown), body(variantContent || ''));
      });
    } else {
      lines.push(body(content || ''));
      if (variants != null) lines.push('Stored variants:', metadataBlock(variants, markdown));
    }
  }
  return lines.join('\n\n') + '\n';
}

async function exportChat(payload = {}, { dialog, writeFile = fs.writeFile } = {}) {
  try {
    const { chatId, format } = payload ?? {};
    const { name, extension } = exportFormat(format);
    const snapshot = getFullChatHistory(chatId);
    const title = String(snapshot.session.title || 'Untitled chat').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || 'chat';
    const output = await formatChatExport(snapshot, format);
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export Chat', defaultPath: `Chat - ${title}.${extension}`,
      filters: [{ name, extensions: [extension] }], properties: ['showOverwriteConfirmation'],
    });
    if (canceled || !filePath) return { success: false, canceled: true };
    if (!path.isAbsolute(filePath)) throw new Error('Choose an absolute file path.');
    await writeFile(filePath, output, { encoding: 'utf8' });
    return { success: true, filePath };
  } catch (error) { return { success: false, error: error.message || 'Could not export chat.' }; }
}

module.exports = { getFullChatHistory, formatChatExport, exportChat };
