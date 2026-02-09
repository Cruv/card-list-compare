#!/bin/sh

# Start backend
cd /app/server
node index.js &

# Start nginx in foreground
nginx -g "daemon off;"
