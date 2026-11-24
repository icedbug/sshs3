FROM sshs3lab/base:1
RUN apt-get update && apt-get install -y --no-install-recommends redis-server \
 && rm -rf /var/lib/apt/lists/* && systemctl enable redis-server
