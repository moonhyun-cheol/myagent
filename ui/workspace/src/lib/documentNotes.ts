import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Mapping } from '@tiptap/pm/transform';
import type { DocumentNote } from '../api/documentClient';

/** Positions are editor positions, never Markdown character offsets. */
export function trackDocumentNotes(notes: DocumentNote[], doc: ProseMirrorNode, revision: number, mapping?: Mapping): DocumentNote[] {
  let text = ''; const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock && text) { text += '\n'; positions.push(-1); }
    if (node.isText && node.text) { for (let i=0;i<node.text.length;i++) { text += node.text[i]; positions.push(pos+i); } }
  });
  const valid = (from:number,to:number,quote:string) => from>=0 && to>from && to<=doc.content.size && doc.textBetween(from,to,'\n')===quote;
  return notes.map(note => {
    if (note.detached || !note.quote) return {...note,detached:true};
    if (mapping) {
      const from=mapping.mapResult(note.from,1), to=mapping.mapResult(note.to,-1);
      if (!from.deleted && !to.deleted && valid(from.pos,to.pos,note.quote)) return {...note,from:from.pos,to:to.pos,revision,detached:false};
    }
    const start=text.indexOf(note.quote);
    if (start>=0 && text.indexOf(note.quote,start+1)<0) {
      const from=positions[start], to=positions[start+note.quote.length-1]+1;
      if (valid(from,to,note.quote)) return {...note,from,to,revision,detached:false};
    }
    return {...note,revision,detached:true};
  });
}
