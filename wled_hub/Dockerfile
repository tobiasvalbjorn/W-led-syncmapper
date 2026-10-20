# Home Assistant app (add-on) image for WLED Hub.
# BUILD_FROM is no longer passed by the Supervisor (2026.04+), so it has a default.
# Check https://github.com/home-assistant/docker-base for the current tag.
ARG BUILD_FROM=ghcr.io/home-assistant/base-python:3.14-alpine3.24
FROM ${BUILD_FROM}

WORKDIR /app
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

COPY wledhub ./wledhub
COPY frontend ./frontend
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD ["/run.sh"]
