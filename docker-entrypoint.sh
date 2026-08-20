#!/bin/sh

PUID=${PUID:-1000}
PGID=${PGID:-1000}

echo "Setting up user abc with UID=$PUID GID=$PGID"

# Remove any existing user/group that conflicts with our target UID/GID
EXISTING_USER=$(getent passwd "$PUID" 2>/dev/null | cut -d: -f1)
EXISTING_GROUP=$(getent group "$PGID" 2>/dev/null | cut -d: -f1)
[ -n "$EXISTING_USER" ] && deluser "$EXISTING_USER" 2>/dev/null || true
[ -n "$EXISTING_GROUP" ] && delgroup "$EXISTING_GROUP" 2>/dev/null || true

# Also remove abc if it exists with a different UID/GID
deluser abc 2>/dev/null || true
delgroup abc 2>/dev/null || true

# Create fresh group and user
addgroup -g "$PGID" abc
adduser -u "$PUID" -G abc -D -H -s /sbin/nologin abc

echo "User abc created: $(id abc)"

# Ensure writable directories exist and are owned by abc
mkdir -p /run/nginx
chown -R abc:abc /app/data
chown -R abc:abc /var/log/nginx
chown -R abc:abc /var/lib/nginx
chown -R abc:abc /run/nginx

# Start backend as unprivileged user. `exec` inside su so node REPLACES su and
# $! is node's own PID — otherwise signals would go to su and never reach node.
su -s /bin/sh abc -c "cd /app/server && exec node index.js" &
BACKEND=$!

# Start nginx (master binds port 80 as root, workers drop to abc)
nginx -g "daemon off;" &
NGINX=$!

# Forward shutdown to both children. This script is PID 1, so `docker stop`
# signals it and nothing else: without this, node never saw SIGTERM, its
# database-flush handler never ran, and the container just waited out the full
# stop grace period before everything was SIGKILLed.
shutdown() {
  trap '' TERM INT
  kill -TERM "$BACKEND" 2>/dev/null
  kill -TERM "$NGINX" 2>/dev/null
  wait "$BACKEND" 2>/dev/null
  wait "$NGINX" 2>/dev/null
  exit 0
}
trap shutdown TERM INT

# If EITHER process exits, bring the container down so the restart policy can act.
# Previously nginx held PID 1, so a dead backend left a "healthy-looking" zombie
# container serving the SPA with a broken API.
while kill -0 "$BACKEND" 2>/dev/null && kill -0 "$NGINX" 2>/dev/null; do
  sleep 5
done

echo "docker-entrypoint: a service exited — stopping container"
kill -TERM "$BACKEND" 2>/dev/null
kill -TERM "$NGINX" 2>/dev/null
wait "$BACKEND" 2>/dev/null
wait "$NGINX" 2>/dev/null
exit 1
