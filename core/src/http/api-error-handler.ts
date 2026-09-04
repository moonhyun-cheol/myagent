import type { ServerResponse } from 'node:http';
import { ProviderError } from '../providers/types.js';
import { ModelUploadError } from '../models/model-upload.js';
import { UploadError } from '../attachments/attachment-service.js';
import { SetupError } from '../setup/setup-service.js';
import { sendJson } from './json.js';

export function handleApiError(res: ServerResponse, e: unknown): void {
  if (e instanceof SetupError) {
    sendJson(res, 400, { error: e.code, message: e.message });
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
  if (e instanceof UploadError) {
    const status = e.code === 'FILE_TOO_LARGE' ? 413 : 400;
    sendJson(res, status, { error: e.code, message: e.message });
    return;
  }
  console.error(e);
  sendJson(res, 500, { ok: false, error: 'INTERNAL_ERROR', note: 'Internal server error' });
}
