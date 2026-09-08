import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './MessageMarkdown.css';

// Presentation only: never write parsed content back to the conversation or task ledger.
const plugins: NonNullable<React.ComponentProps<typeof ReactMarkdown>['remarkPlugins']> = [[remarkGfm, { singleTilde: false }]];
export function safeMarkdownUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch { return ''; }
}
function CodeBlock({ text, language, copyText }: { text: string; language: string; copyText: (text: string) => Promise<boolean> }) {
  const [status, setStatus] = useState('복사');
  return <section className="message-code-block" aria-label="코드 블록">
    <header><span>{language || 'text'}</span><button type="button" aria-label="코드 블록 복사" onClick={async () => {
      try { setStatus(await copyText(text) ? '복사됨' : '복사 실패 · 재시도'); }
      catch { setStatus('복사 실패 · 재시도'); }
    }}>{status}</button></header>
    <pre><code>{text}</code></pre>
  </section>;
}
export const MessageMarkdown = memo(function MessageMarkdown({ text, onOpenUrl, copyText }: {
  text: string;
  onOpenUrl: (url: string) => unknown;
  copyText: (text: string) => Promise<boolean>;
}) {
  return <div className="message-markdown">
    <ReactMarkdown remarkPlugins={plugins} skipHtml urlTransform={safeMarkdownUrl} components={{
      pre({ node, children }) {
        const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code');
        if (!code || code.type !== 'element') return <pre>{children}</pre>;
        const value = code.children.map(child => child.type === 'text' ? child.value : '').join('');
        const classes = code.properties.className;
        const language = (Array.isArray(classes) ? classes : []).map(String).find(value => value.startsWith('language-'))?.slice(9) || '';
        // HAST adds one terminal newline; remove only that renderer-added delimiter.
        return <CodeBlock text={value.replace(/\n$/, '')} language={language} copyText={copyText} />;
      },
      a({ href, children }) {
        const url = safeMarkdownUrl(href || '');
        return url ? <a href={url} onClick={event => { event.preventDefault(); event.stopPropagation(); onOpenUrl(url); }}>{children}</a> : <span>{children}</span>;
      },
      img({ alt }) { return <span className="message-image-label">[이미지: {alt || '설명 없음'} · 자동 로딩 안 함]</span>; },
      table({ children }) { return <div className="message-table-scroll"><table>{children}</table></div>; },
      input({ checked }) { return <input type="checkbox" checked={checked ?? false} disabled readOnly aria-label="표시용 체크리스트" />; },
    }}>{text}</ReactMarkdown>
  </div>;
});
