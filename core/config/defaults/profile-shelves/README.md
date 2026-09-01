# Work kit shelves (authoritative catalog = remote feed)

Neutral core ships **schema templates only** (`_template/`). Brand kits (CQR, TSLA, …) are published via the work-kit catalog feed and installed per shelf into the personal pack locker.

## Locker layout (installed shelves)

```
{LOCKER}/.catalog-feed.json
{LOCKER}/profiles/{group}/group.json
{LOCKER}/profiles/{group}/{kitId}/shelf.json
{LOCKER}/profiles/{group}/{kitId}/.install-meta.json
{LOCKER}/profiles/{group}/{kitId}/agent-plugins/…
{LOCKER}/profiles/{group}/{kitId}/skills/…
```

## Authoring

Copy `_template/` examples, fill `shelf.json`, package as per-shelf tarball for feed `asset`.
