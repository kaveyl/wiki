# Samba server AND client for tests only (AD-038): the backup tests talk to it through the
# `smbclient` wrapper next to this file (docker exec), so the VM needs no Samba packages.
# Never part of the product image; started by scripts/smb-test.sh on 127.0.0.1 only.
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends samba smbclient \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -M -s /usr/sbin/nologin kwtest \
 && mkdir -p /share && chown kwtest /share
COPY smb.conf /etc/samba/smb.conf
# Test account only (container lives on 127.0.0.1 during a test run).
RUN printf 'kwtest-Pass1\nkwtest-Pass1\n' | smbpasswd -a -s kwtest
EXPOSE 445
CMD ["smbd", "--foreground", "--no-process-group", "--debug-stdout"]
