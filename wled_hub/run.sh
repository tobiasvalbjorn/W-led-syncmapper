#!/command/with-contenv bashio
# shellcheck shell=bash
# Options are read by the hub itself from /data/options.json.
bashio::log.info "Starting WLED Hub"
export INGRESS_PORT=8099
cd /app || exit 1
exec python3 -m wledhub --data /data --frontend /app/frontend
