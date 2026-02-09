#!/bin/sh

PUID=${PUID:-1000}
PGID=${PGID:-1000}

# Create group and user with requested IDs
addgroup -g "$PGID" abc 2>/dev/null
adduser -u "$PUID" -G abc -D -H -s /sbin/nologin abc 2>/dev/null

# Fix ownership on writable directories
chown -R abc:abc /app/data
chown -R abc:abc /var/log/nginx
chown -R abc:abc /var/lib/nginx
touch /tmp/nginx.pid && chown abc:abc /tmp/nginx.pid

# Start backend as unprivileged user
su -s /bin/sh abc -c "cd /app/server && node index.js" &

# Start nginx (master binds port 80 as root, workers drop to abc)
nginx -g "daemon off;"
