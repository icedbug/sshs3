# A server for the lab: Ubuntu 24.04 with systemd as PID 1, sshd, cron and syslog, like a small VM.
FROM ubuntu:24.04
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      systemd systemd-sysv openssh-server sudo curl less vim-tiny procps iproute2 nftables \
      dnsutils lsof psmisc jq python3 ca-certificates iputils-ping cron rsyslog \
 && rm -rf /var/lib/apt/lists/*
# Units a container has no use for: they wait for hardware or a console that is not there.
RUN systemctl mask systemd-udevd.service systemd-udevd-kernel.socket systemd-udevd-control.socket \
      systemd-modules-load.service sys-kernel-config.mount sys-kernel-debug.mount \
      getty.target console-getty.service systemd-firstboot.service \
 && systemctl enable ssh cron rsyslog
# Root logs in by key only: the lab's control key, and the keys a test puts there.
RUN sed -i -E 's/^#?PermitRootLogin.*/PermitRootLogin prohibit-password/; s/^#?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && mkdir -p /root/.ssh && chmod 700 /root/.ssh
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
