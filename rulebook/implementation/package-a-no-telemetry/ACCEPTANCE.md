# Package A — undeclared debug telemetry

## Contract

- **Related**: RC-012 (external_error_transmission_absent)
- **Observer**: API consumer / local administrator

## Input

- Normal API error path (dispatch catch, attachment upload, multipart boundary missing)

## Output (oracle)

- Zero HTTP request to `127.0.0.1:7742` or `:7742/ingest` in product source trees
- Documented JSON error response unchanged

## Verification

```bash
node tools/verify-no-debug-telemetry.mjs
```

## Changed surface

- `core/src/api-server.ts`
- `core/src/http/api-error-handler.ts`
- `core/src/routes/dispatch.ts`
- `core/src/attachments/multipart.ts`
