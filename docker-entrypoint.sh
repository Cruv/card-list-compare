#!/bin/sh
set -e

PUID=${PUID:-1000}
PGID=${PGID:-1000}

echo "Setting up user abc with UID=$PUID GID=$PGID"

# Remove existing abc user/group if present (from a previous run or image layer)
deluser abc 2>/dev/null || true
delgroup abc 2>/dev/null || true

# If a group with this GID already exists, use it; otherwise create abc group
EXISTING_GROUP=$(getent group "$PGID" | cut -d: -f1)
if [ -z "$EXISTING_GROUP" ]; then
    addgroup -g "$PGID" abc
    GROUP_NAME=abc
else
    GROUP_NAME="$EXISTING_GROUP"
fi

# If a user with this UID already exists, remove it first
EXISTING_USER=$(getent passwd "$PUID" | cut -d: -f1)
if [ -n "$EXISTING_USER" ] && [ "$EXISTING_USER" != "abc" ]; then
    deluser "$EXISTING_USER" 2>/dev/null || true
fi

# Create abc user with the target UID and group
adduser -u "$PUID" -G "$GROUP_NAME" -D -H -s /sbin/nologin abc 2>/dev/null || true

echo "User abc created: $(id abc)"

# Fix ownership on writable directories
chown -R abc:abc /app/data
chown -R abc:abc /var/log/nginx
chown -R abc:abc /var/lib/nginx
touch /tmp/nginx.pid && chown abc:abc /tmp/nginx.pid

# Start backend as unprivileged user
su -s /bin/sh abc -c "cd /app/server && node index.js" &

# Start nginx (master binds port 80 as root, workers drop to abc)
nginx -g "daemon off;"
