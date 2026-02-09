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

# Start backend as unprivileged user
su -s /bin/sh abc -c "cd /app/server && node index.js" &

# Start nginx (master binds port 80 as root, workers drop to abc)
nginx -g "daemon off;"
