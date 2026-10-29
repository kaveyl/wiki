#!/bin/sh
# Base image of the Dockerfile, pinned by digest (AD-048, addendum to AD-041): both stages use
# FROM <tag>@sha256:<digest of the multi-arch index>, so a release build is traceable. docs/WARTUNG.md §5.
#   check            does the tag point to another digest by now? exit 0 = current, 1 = new digest, 2 = error
#   update [digest]  write the tag's current digest (or the given sha256:…) into both FROM lines
# Only reads from the registry (docker buildx imagetools inspect), builds nothing.
# e2e/smb/Dockerfile keeps the moving tag on purpose: a local test container, never shipped (AD-038).
set -e
cd "$(dirname "$0")/.."
FILE=${DOCKERFILE:-Dockerfile}
die() { echo "base-image: $*" >&2; exit 2; }
# The whole value is "sha256:" plus 64 lowercase hex digits (grep would only test it line by line).
is_digest() {
  case "$1" in sha256:*) ;; *) return 1 ;; esac
  hex=${1#sha256:}
  [ ${#hex} -eq 64 ] || return 1
  case "$hex" in *[!0123456789abcdef]*) return 1 ;; esac
}

[ -f "$FILE" ] || die "$FILE fehlt"
tag=$(sed -n 's/^FROM \([^@ ]*\).*/\1/p' "$FILE" | sort -u)
[ -n "$tag" ] || die "keine FROM-Zeile in $FILE"
[ "$(printf '%s\n' "$tag" | wc -l)" -eq 1 ] || die "die Stufen in $FILE nutzen verschiedene Basis-Images: $(echo $tag)"
# Pinned digest: the same in every FROM line, else empty.
lines=$(grep -c '^FROM ' "$FILE")
pinned=$(sed -n 's/^FROM [^@ ]*@\(sha256:[0-9a-f]\{64\}\)\( .*\)\{0,1\}$/\1/p' "$FILE" | sort -u)
[ "$(grep -Ec '^FROM [^@ ]+@sha256:[0-9a-f]{64}( |$)' "$FILE")" -eq "$lines" ] && [ "$(printf '%s\n' "$pinned" | wc -l)" -eq 1 ] || pinned=

remote() {
  d=$(docker buildx imagetools inspect "$tag" --format '{{.Manifest.Digest}}') || die "Registry nicht erreichbar für $tag"
  is_digest "$d" || die "unerwartete Antwort für $tag: $d"
  echo "$d"
}

case "$1" in
  check)
    now=$(remote)
    if [ -z "$pinned" ]; then
      echo "$tag ist nicht in allen FROM-Zeilen per Digest festgelegt – aktuell: $now (scripts/base-image.sh update)"
      exit 1
    fi
    if [ "$pinned" = "$now" ]; then
      echo "$tag: aktuell ($pinned)"
      exit 0
    fi
    echo "$tag: neuer Digest $now (im Dockerfile: $pinned) – scripts/base-image.sh update, dann bauen und testen"
    exit 1
    ;;
  update)
    if [ -n "$2" ]; then new=$2; else new=$(remote); fi
    is_digest "$new" || die "kein Digest: $new"
    re=$(printf '%s' "$tag" | sed 's/[].[*^$\\/#]/\\&/g')
    out=$(sed -E "s#^FROM $re(@sha256:[0-9a-f]{64})?( |\$)#FROM $tag@$new\\2#" "$FILE")
    printf '%s\n' "$out" > "$FILE" # keeps the file's mode
    if [ "$pinned" = "$new" ]; then echo "$tag: unverändert ($new)"; else echo "$tag: ${pinned:-ohne Digest} → $new"; fi
    ;;
  *)
    die "usage: scripts/base-image.sh check|update [sha256:…]"
    ;;
esac
