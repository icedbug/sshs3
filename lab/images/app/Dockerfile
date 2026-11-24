ARG BASE=sshs3lab/base:2
FROM ${BASE}
RUN apt-get update && apt-get install -y --no-install-recommends python3-psycopg2 python3-redis postgresql-client redis-tools \
 && rm -rf /var/lib/apt/lists/*
