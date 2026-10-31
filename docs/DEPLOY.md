# Deploying OrbytLink

Production runs on the VPS as one container behind Caddy, which serves
`app.orbytlink.com` over HTTPS and proxies to `127.0.0.1:3080`. Code reaches the VPS only
by `git pull` from GitHub.

## First deploy

1. On the VPS, in the checkout: `cp .env.production.example .env` and fill it in.
   Generate `SECRET_KEY` once and save it in a password manager. Without it, stored
   credentials (and every backup) are unreadable.
2. `docker compose -f deploy-compose.yml up -d --build`
3. Check `curl -s 127.0.0.1:3080/api/health` and sign in at https://app.orbytlink.com.

The container keeps its data in the `orbytlink-gateway_orbytlink-data` volume; `docker compose down` keeps
it, `down -v` deletes it.

## Updating

```
git pull
docker compose -f deploy-compose.yml up -d --build
```

Stopping waits up to 135 s for in-flight tool calls to finish.

## Backups

Nightly, from the host's crontab (`crontab -e`):

```
0 3 * * * cd /root/orbytlink && docker compose -f deploy-compose.yml exec -T api node scripts/backup.mjs >> /var/log/orbytlink-backup.log 2>&1
```

It keeps the newest 14 copies in the `orbytlink-gateway_orbytlink-backups` volume. Copy them off the VPS
regularly. A backup held on the same disk does not survive losing that disk.

To restore: stop the container, copy a backup over `/app/data/orbytlink.sqlite` (deleting
the `-wal` and `-shm` files beside it), and start it with the same `SECRET_KEY`.

## Logs

`docker compose -f deploy-compose.yml logs -f api`. Unexpected errors, failed tool calls
and failed workflow steps are logged; request bodies and credentials never are.

## Settings that matter

| Setting | Why |
| --- | --- |
| `TRUST_PROXY=uniquelocal` | Caddy reaches the container over the Docker network. `loopback` makes every sign-in fail with 426, and leaving it unset gives every user one shared rate limit. |
| `OUTBOUND_HOSTS` | Hosts the gateway may call. `*` allows any public HTTPS host; private ranges are always blocked. |
| `TOOL_TIMEOUT_MS` | Longest single upstream tool call (default 120000). |
