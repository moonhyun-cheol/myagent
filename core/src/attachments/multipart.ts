import type { IncomingMessage } from 'node:http';

export interface ParsedMultipartFile {
  fieldName: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

/** Minimal multipart/form-data parser (single or multiple file parts). */
export async function parseMultipart(req: IncomingMessage): Promise<ParsedMultipartFile[]> {
  const contentType = req.headers['content-type'] ?? '';
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!match) {
    // #region agent log
    fetch('http://127.0.0.1:7742/ingest/aa87bd6c-3a9c-4926-a486-5ea0781a9b81',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'b87a06'},body:JSON.stringify({sessionId:'b87a06',runId:'pre-fix',hypothesisId:'H1_H2',location:'multipart.ts:boundary-missing',message:'MULTIPART_BOUNDARY_MISSING',data:{contentType:String(contentType).slice(0,200),method:req.method??'',url:String(req.url??'').slice(0,120),hasContentLength:Boolean(req.headers['content-length']),transferEncoding:String(req.headers['transfer-encoding']??'')},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    throw new Error('MULTIPART_BOUNDARY_MISSING');
  }
  const boundary = match[1] ?? match[2];
  const raw = await readRawBody(req);
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = splitBuffers(raw, delimiter).filter((p) => p.length > 0 && !p.equals(Buffer.from('--\r\n')));

  const files: ParsedMultipartFile[] = [];
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headerText = part.subarray(0, headerEnd).toString('utf8');

    const nameMatch = /name="([^"]+)"/i.exec(headerText);
    const fileMatch = /filename="([^"]*)"/i.exec(headerText);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);

    // filename이 없거나 빈 문자열이어도 image/* 파트는 클립보드 붙여넣기로 간주하여 수용
    const detectedType = typeMatch?.[1]?.trim().toLowerCase() ?? '';
    const isImagePart = detectedType.startsWith('image/');
    const rawName = fileMatch?.[1]?.trim() ?? '';
    if (!rawName && !isImagePart) continue;

    let body = part.subarray(headerEnd + 4);
    if (body.subarray(-2).equals(Buffer.from('\r\n'))) {
      body = body.subarray(0, body.length - 2);
    }

    const fallbackExt = detectedType.split('/')[1]?.split(';')[0] ?? 'png';
    const filename = rawName || `paste-${Date.now()}.${fallbackExt}`;

    files.push({
      fieldName: nameMatch?.[1] ?? 'file',
      filename,
      contentType: typeMatch?.[1]?.trim() ?? (isImagePart ? `image/${fallbackExt}` : 'application/octet-stream'),
      data: body,
    });
  }

  return files;
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function splitBuffers(buf: Buffer, sep: Buffer): Buffer[] {
  const result: Buffer[] = [];
  let start = 0;
  let idx = buf.indexOf(sep, start);
  while (idx !== -1) {
    if (idx > start) result.push(buf.subarray(start, idx));
    start = idx + sep.length;
    if (buf.subarray(start, start + 2).equals(Buffer.from('\r\n'))) start += 2;
    idx = buf.indexOf(sep, start);
  }
  if (start < buf.length) result.push(buf.subarray(start));
  return result;
}
