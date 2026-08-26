#!/usr/bin/env node
/** Build a minimal valid .docx under fixtures/docs (no Word dependency). */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const docs = path.join(root, 'tools/fpv/fixtures/docs');
const tmp = path.join(root, 'data', '_fpv', '_docx_build');
const docx = path.join(docs, 'strategy.docx');
const zipPath = path.join(docs, 'strategy.zip');

mkdirSync(docs, { recursive: true });
rmSync(tmp, { recursive: true, force: true });
mkdirSync(path.join(tmp, 'word'), { recursive: true });
mkdirSync(path.join(tmp, '_rels'), { recursive: true });

writeFileSync(
  path.join(tmp, '[Content_Types].xml'),
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>
`,
);

writeFileSync(
  path.join(tmp, '_rels', '.rels'),
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
`,
);

writeFileSync(
  path.join(tmp, 'word', 'document.xml'),
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Example Product Strategy (FPV fixture)</w:t></w:r></w:p>
    <w:p><w:r><w:t>Purpose: build a reliable local AI workspace.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Priorities: grounded research, user-provided context, and safe code mutation.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Key risks: missing fixtures, session context loss, and ambiguous product inputs.</w:t></w:r></w:p>
  </w:body>
</w:document>
`,
);

rmSync(docx, { force: true });
rmSync(zipPath, { force: true });
execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${tmp}\\*' -DestinationPath '${zipPath}' -Force; Move-Item -Force '${zipPath}' '${docx}'`,
  ],
  { stdio: 'inherit' },
);

if (!existsSync(docx) || readFileSync(docx).length < 100) {
  console.error('docx seed failed');
  process.exit(1);
}
console.log(`wrote ${docx} (${readFileSync(docx).length} bytes)`);
