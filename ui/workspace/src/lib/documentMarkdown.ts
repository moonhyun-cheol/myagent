import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableKit } from '@tiptap/extension-table';
import { Marked, type marked } from 'marked';

export const documentMarkdown = new Marked({ gfm: true });
documentMarkdown.use({ tokenizer: { del(src) {
  const match = /^~~(?=\S)([\s\S]*?\S)~~/.exec(src);
  if (match) return {type:'del',raw:match[0],text:match[1],tokens:this.lexer.inlineTokens(match[1])};
  return undefined;
} } });
export function documentExtensions() {
  return [StarterKit.configure({ link: { openOnClick:false, autolink:false, isAllowedUri: safeDocumentLink } }), TableKit, Markdown.configure({ marked: documentMarkdown as unknown as typeof marked })];
}
export function documentLinkTarget(url: string): {path:string; anchor:string} | null {
  if (/[\u0000-\u0020\u007f\\]/.test(url) || url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  try {
    const [rawPath,rawAnchor,...extra]=url.split('#');
    if (extra.length) return null;
    let target=decodeURIComponent(rawPath), anchor=decodeURIComponent(rawAnchor??'');
    if (/[\u0000-\u001f\u007f\\:%?#]/.test(target) || /[\u0000-\u001f\u007f]/.test(anchor)) return null;
    if (target.startsWith('./')) target=target.slice(2);
    if (!target) return anchor ? {path:'',anchor}:null;
    if (target.startsWith('/') || !/\.md$/i.test(target) || target.split('/').some(p=>!p || p==='.' || p==='..')) return null;
    return {path:target,anchor};
  } catch { return null; }
}
export function safeDocumentLink(url: string): boolean {
  if (/^https?:\/\//i.test(url)) { try { const parsed=new URL(url); return !/[\u0000-\u0020\u007f\\]/.test(url) && Boolean(parsed.hostname) && !parsed.username && !parsed.password; } catch { return false; } }
  return documentLinkTarget(url)!==null;
}
/** Unsupported syntax stays in the original buffer; never silently round-trip it away. */
export function requiresSourceEditing(markdown: string): boolean {
  let unsupported = false;
  documentMarkdown.walkTokens(documentMarkdown.lexer(markdown), token => {
    if (['html','image','def'].includes(token.type) || (token.type === 'list_item' && 'task' in token && token.task)) unsupported = true;
  });
  return unsupported || /^---\s*\n/.test(markdown);
}
