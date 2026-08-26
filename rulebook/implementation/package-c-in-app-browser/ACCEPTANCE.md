# Package C — in-app browser acceptance

## Contract

- **Related**: RC-006 (draft)
- **Observer**: desktop_end_user

## Automatic (structural witness)

Proves ChatPane → WebView postMessage → shell handler wiring exists.

```bash
node tools/verify-in-app-browser-path.mjs
```

## Manual (user-visible — RC-006 promotion)

See [MANUAL.md](MANUAL.md). Until manual steps pass, RC-006 stays `UNVERIFIED`.

## Changed surface

- Structural only in this package; product UI/shell already wired
