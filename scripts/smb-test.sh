#!/bin/sh
# Samba test container for the backup tests (AD-038): `up` builds and starts it (no published
# port – tests reach it through e2e/smb/smbclient via docker exec), `down` removes it.
# Share //localhost/backup, account kwtest / kwtest-Pass1 (test only).
set -e
cd "$(dirname "$0")/.."
case "$1" in
  up)
    docker build -q -t kaveyl-wiki-smbtest e2e/smb >/dev/null
    docker rm -f kaveyl-wiki-smbtest >/dev/null 2>&1 || true
    docker run -d --name kaveyl-wiki-smbtest kaveyl-wiki-smbtest >/dev/null
    sleep 1
    echo "kaveyl-wiki-smbtest läuft"
    ;;
  down)
    docker rm -f kaveyl-wiki-smbtest >/dev/null 2>&1 || true
    echo "kaveyl-wiki-smbtest entfernt"
    ;;
  *)
    echo "usage: scripts/smb-test.sh up|down" >&2
    exit 2
    ;;
esac
