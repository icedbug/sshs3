ARG BASE=sshs3lab/base:2
FROM ${BASE}
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-16 rclone \
 && rm -rf /var/lib/apt/lists/*
