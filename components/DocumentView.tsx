import type { ReactNode } from 'react';

// Renders the Markdown documents ASK IT generates (headings, bullets, tables, **bold**).
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part,
  );
}

export function DocumentView({ markdown }: { markdown: string }) {
  const out: ReactNode[] = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('# ')) out.push(<h1 key={i}>{line.slice(2)}</h1>);
    else if (line.startsWith('## ')) out.push(<h2 key={i}>{line.slice(3)}</h2>);
    else if (line.startsWith('- ')) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith('- ')) items.push(lines[i++].slice(2));
      i--;
      out.push(<ul key={i}>{items.map((t, k) => <li key={k}>{inline(t)}</li>)}</ul>);
    } else if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        if (!/^\|\s*-/.test(lines[i])) rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()));
        i++;
      }
      i--;
      const [head, ...body] = rows;
      out.push(
        <table key={i}>
          <thead><tr>{head.map((c, k) => <th key={k}>{c}</th>)}</tr></thead>
          <tbody>{body.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
        </table>,
      );
    } else if (line.trim()) out.push(<p key={i}>{inline(line)}</p>);
  }
  return <div className="wc-doc">{out}</div>;
}
