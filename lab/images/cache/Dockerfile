ARG BASE=sshs3lab/base:2
FROM ${BASE}
RUN apt-get update && apt-get install -y --no-install-recommends redis-server \
 && rm -rf /var/lib/apt/lists/* && systemctl enable redis-server
