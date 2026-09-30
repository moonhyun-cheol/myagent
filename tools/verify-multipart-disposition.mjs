#!/usr/bin/env node
// 첨부 multipart Content-Disposition 해석 회귀 검증 (셸 드롭 업로드 400 NO_FILES 재발 방지)
import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parseMultipart, parseContentDisposition } = await import(
  pathToFileURL(path.join(root, 'core/dist/attachments/multipart.js')).href
);

const cd = (params) => `Content-Disposition: form-data; ${params}\r\nContent-Type: application/octet-stream`;

// 1) 브라우저 형식 (따옴표)
assert.deepEqual(parseContentDisposition(cd('name="file"; filename="a.txt"')), { name: 'file', filename: 'a.txt' });
// 2) .NET 셸 형식 (따옴표 없음 + filename*)
assert.deepEqual(
  parseContentDisposition(cd("name=file; filename=drop-repro.txt; filename*=utf-8''drop-repro.txt")),
  { name: 'file', filename: 'drop-repro.txt' },
);
// 3) .NET 한글 파일명: RFC 2047 filename + RFC 5987 filename* -> filename* 우선
assert.deepEqual(
  parseContentDisposition(
    cd("name=file; filename=\"=?utf-8?B?67O06rOg7IScLnBkZg==?=\"; filename*=utf-8''%EB%B3%B4%EA%B3%A0%EC%84%9C.pdf"),
  ),
  { name: 'file', filename: '보고서.pdf' },
);
// 4) RFC 2047 단독
assert.equal(parseContentDisposition(cd('name=file; filename="=?utf-8?B?67O06rOg7IScLnBkZg==?="')).filename, '보고서.pdf');
// 5) name 파라미터가 filename 안에서 오인되지 않음
assert.deepEqual(parseContentDisposition(cd('filename="x.png"')), { name: '', filename: 'x.png' });
// 6) 따옴표 안의 세미콜론
assert.equal(parseContentDisposition(cd('name="file"; filename="a;b.txt"')).filename, 'a;b.txt');

// end-to-end: .NET MultipartFormDataContent와 같은 바디를 parseMultipart에 통과
function fakeReq(boundary, body) {
  const req = Readable.from([Buffer.from(body, 'utf8')]);
  req.headers = { 'content-type': `multipart/form-data; boundary="${boundary}"` };
  return req;
}
const boundary = 'b0a1f2c3-dotnet';
const body =
  `--${boundary}\r\n` +
  `Content-Type: application/octet-stream\r\n` +
  `Content-Disposition: form-data; name=file; filename=report.pdf; filename*=utf-8''report.pdf\r\n\r\n` +
  `hello\r\n` +
  `--${boundary}\r\n` +
  `Content-Type: application/octet-stream\r\n` +
  `Content-Disposition: form-data; name=file; filename="=?utf-8?B?67O06rOg7IScLnBkZg==?="; filename*=utf-8''%EB%B3%B4%EA%B3%A0%EC%84%9C.pdf\r\n\r\n` +
  `world\r\n` +
  `--${boundary}--\r\n`;
const files = await parseMultipart(fakeReq(boundary, body));
assert.equal(files.length, 2, 'unquoted .NET parts must not be skipped (NO_FILES)');
assert.equal(files[0].filename, 'report.pdf');
assert.equal(files[0].fieldName, 'file');
assert.equal(files[0].data.toString('utf8'), 'hello');
assert.equal(files[1].filename, '보고서.pdf');
assert.equal(files[1].data.toString('utf8'), 'world');

console.log('verify-multipart-disposition OK');
