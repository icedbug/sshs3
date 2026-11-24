FROM sshs3lab/base:1
RUN apt-get update && apt-get install -y --no-install-recommends nginx openssl logrotate \
 && rm -rf /var/lib/apt/lists/* && systemctl enable nginx
