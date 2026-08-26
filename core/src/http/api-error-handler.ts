import type { ServerResponse } from 'node:http';
import { LicenseGateError } from '../license/types.js';
import { ProviderError } from '../providers/types.js';
import { ModelUploadError } from '../models/model-upload.js';
import { UploadError } from '../attachments/attachment-service.js';
import { SetupError } from '../setup/setup-service.js';
import { sendJson } from './json.js';

export function handleApiError(res: ServerResponse, e: unknown): void {
  if (e instanceof SetupError) {
    const status =
      e.code === 'LICENSE_MACHINE_MISMATCH' ||
      e.code === 'LICENSE_MACHINE_REQUIRED' ||
      e.code === 'LICENSE_USER_MISMATCH'
        ? 403
        : 400;
    sendJson(res, status, { error: e.code, message: e.message });
    return;
  }
  if (e instanceof ProviderError) {
    const status =
      e.code === 'PROVIDER_NOT_CONFIGURED' || e.code === 'API_KEY_EMPTY' ? 400 : 404;
    sendJson(res, status, { error: e.code, message: e.message });
    return;
  }
  if (e instanceof ModelUploadError) {
    const status = e.code === 'FILE_TOO_LARGE' ? 413 : 400;
    sendJson(res, status, { error: e.code, message: e.message });
    return;
  }
  if (e instanceof LicenseGateError) {
    sendJson(res, 403, { error: e.code, message: e.message });
    return;
  }
  if (e instanceof UploadError) {
    const status = e.code === 'FILE_TOO_LARGE' ? 413 : 400;
    sendJson(res, status, { error: e.code, message: e.message });
    return;
  }
  // #region agent log
  const errMsg = e instanceof Error ? e.message : String(e);
  const errName = e instanceof Error ? e.name : typeof e;
  fetch('http://127.0.0.1:7742/ingest/aa87bd6c-3a9c-4926-a486-5ea0781a9b81',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'b87a06'},body:JSON.stringify({sessionId:'b87a06',runId:'pre-fix',hypothesisId:'H3_H5',location:'api-error-handler.ts:fallback',message:'untyped error -> console.error+500',data:{errName,errMsg:errMsg.slice(0,200),headersSent:res.headersSent,writableEnded:res.writableEnded},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  console.error(e);
  sendJson(res, 500, { ok: false, error: 'INTERNAL_ERROR', note: 'Internal server error' });
}
