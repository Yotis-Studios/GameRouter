#!/usr/bin/env bash
# game-release.sh -- deploy a game server without restarting the router or touching a live match.
#
# THE LAYOUT. A game's serverDir (games.json, or GAME_SERVER_DIR) is a symlink to the current
# release; the releases sit beside it:
#
#     /home/server/shikikan            -> shikikan.releases/v0.3.4-09c5f44
#     /home/server/shikikan.releases/
#         v0.3.3-5dbe7b7/              the previous one, kept for rollback
#         v0.3.4-09c5f44/
#         HISTORY                      what was activated, when, by whom
#
# The router resolves the link once per match, when it starts it (Game.js resolveRelease), and
# the match runs in that directory until it ends. So switching the link is the whole deploy: the
# next match runs the new release, running ones finish on theirs, the router keeps running. A
# release is deleted only by `prune`, and never while a process is running in it.
#
# Run as root on the router host (it reads every process's cwd to see which releases are live).
#
#   game-release.sh status   <link>
#   game-release.sh install  <link> <name> [--owner user]      a .tar.gz of the release on stdin
#   game-release.sh preflight <link> <name> [--start "cmd"] [--env K=V ...] [--timeout s]
#   game-release.sh activate <link> <name> [preflight options] [--no-preflight]
#   game-release.sh deploy   <link> <name> [--owner user] [preflight options]   install+activate
#   game-release.sh rollback <link>                            back to the release before this one
#   game-release.sh prune    <link> [--keep N]                 delete old releases nobody runs
#
# The first install or activate on a link that is still a plain directory ADOPTS it: the
# directory moves into the releases as "adopted-<timestamp>" and the link takes its place. A move
# keeps the inode, so matches running from it carry on.
#
# PREFLIGHT starts the release the way the router would (default `hemlock server.hml`, or
# --start; --env adds environment such as a port range) and requires the {"event":"port"} line
# within --timeout seconds (default 10) and that port listening. Activate refuses a release that
# fails it unless --no-preflight.
#
# From a dev machine, the courier is ssh:
#   git -C ~/Projects/shikikan.hml archive --format=tar.gz HEAD | \
#     ssh root@host game-release.sh deploy /home/server/shikikan v0.3.4-09c5f44 --owner server
# (a release that needs dependencies -- shikikan's hem_modules -- is packed WITH them; nothing
# is installed on the host.)
set -euo pipefail

die()  { echo "game-release: $*" >&2; exit 1; }
say()  { echo "game-release: $*"; }

[ $# -ge 2 ] || { sed -n '2,40p' "$0"; exit 2; }
CMD=$1; LINK=${2%/}; shift 2
REL="$LINK.releases"
NAME_RE='^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'

OWNER=""; START="hemlock server.hml"; TIMEOUT=10; KEEP=3; PREFLIGHT=1; ENVS=()
NAME=""
if [[ "$CMD" =~ ^(install|preflight|activate|deploy)$ ]]; then
    [ $# -ge 1 ] || die "$CMD needs a release name"
    NAME=$1; shift
    [[ "$NAME" =~ $NAME_RE ]] || die "release name '$NAME': letters, digits, . _ - only"
fi
while [ $# -gt 0 ]; do
    case "$1" in
        --owner) OWNER=$2; shift 2 ;;
        --start) START=$2; shift 2 ;;
        --env) [[ "$2" == *=* ]] || die "--env takes K=V"; ENVS+=("$2"); shift 2 ;;
        --timeout) TIMEOUT=$2; shift 2 ;;
        --keep) KEEP=$2; shift 2 ;;
        --no-preflight) PREFLIGHT=0; shift ;;
        *) die "unknown option $1" ;;
    esac
done

history() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1 ${SUDO_USER:-$(id -un)}" >> "$REL/HISTORY"; }
current() { [ -L "$LINK" ] && basename "$(readlink "$LINK")" || true; }

# Every release some process is running in (its cwd is inside it), one name per line.
live_releases() {
    local real; real=$(cd "$REL" 2>/dev/null && pwd -P) || return 0
    for p in /proc/[0-9]*; do
        local cwd; cwd=$(readlink "$p/cwd" 2>/dev/null) || continue
        case "$cwd" in "$real"/*) local rest=${cwd#"$real"/}; echo "${rest%%/*}" ;; esac
    done | sort -u
}

# A plain directory becomes the first release, with the link in its place.
adopt() {
    mkdir -p "$REL"
    if [ -d "$LINK" ] && [ ! -L "$LINK" ]; then
        local name="adopted-$(date -u +%Y%m%d%H%M%S)"
        mv "$LINK" "$REL/$name"
        ln -s "$(basename "$REL")/$name" "$LINK"
        history "adopt $name"
        say "adopted the plain directory as release $name; $LINK is now a link to it"
    fi
}

switch_to() {
    local name=$1
    [ -d "$REL/$name" ] || die "no release $name in $REL"
    local was; was=$(current)
    # Atomic: a new link renamed over the old one. A match starting at this instant gets one or
    # the other, never neither.
    ln -sfn "$(basename "$REL")/$name" "$LINK.new"
    mv -T "$LINK.new" "$LINK"
    [ -n "$was" ] && [ "$was" != "$name" ] && echo "$was" > "$REL/.previous"
    history "activate $name (was ${was:-none})"
    say "active: $name (was ${was:-none}). Running matches stay on theirs; the next one starts on $name."
}

do_install() {
    adopt
    local dst="$REL/$NAME"
    [ ! -e "$dst" ] || die "release $NAME already exists; pick a new name (they are never overwritten)"
    local tmp="$REL/.incoming-$NAME"
    rm -rf "$tmp"; mkdir -p "$tmp"
    tar -xzf - -C "$tmp" || { rm -rf "$tmp"; die "could not unpack the release from stdin"; }
    [ -z "$OWNER" ] || chown -R "$OWNER:$(id -gn "$OWNER")" "$tmp"
    mv "$tmp" "$dst"
    history "install $NAME"
    say "installed $NAME ($(du -sh "$dst" | cut -f1))"
}

do_preflight() {
    local dir="$REL/$NAME"
    [ -d "$dir" ] || die "no release $NAME in $REL"
    local log; log=$(mktemp)
    local runas=()
    [ -z "$OWNER" ] || runas=(sudo -u "$OWNER")
    local owner_of; owner_of=$(stat -c %U "$dir")
    [ -n "$OWNER" ] || [ "$owner_of" = root ] || [ "$owner_of" = "$(id -un)" ] || runas=(sudo -u "$owner_of")
    [ "${#runas[@]}" -eq 0 ] || [ "${runas[2]}" != "$(id -un)" ] || runas=()
    ( cd "$dir" && exec "${runas[@]}" env "${ENVS[@]}" timeout "$((TIMEOUT + 2))" bash -c "exec $START" ) > "$log" 2>&1 &
    local pid=$! port="" i=0
    while [ $i -lt $((TIMEOUT * 5)) ]; do
        port=$(grep -o '"event":"port","data":[0-9]*' "$log" | head -1 | grep -o '[0-9]*$' || true)
        [ -n "$port" ] && break
        kill -0 $pid 2>/dev/null || break
        sleep 0.2; i=$((i + 1))
    done
    local listening=no
    if [ -n "$port" ]; then
        for _ in 1 2 3 4 5 6 7 8 9 10; do
            if ss -ltn "( sport = :$port )" 2>/dev/null | grep -q ":$port "; then listening=yes; break; fi
            sleep 0.2
        done
    fi
    pkill -TERM -P $pid 2>/dev/null || true; kill $pid 2>/dev/null || true; wait $pid 2>/dev/null || true
    if [ -n "$port" ] && [ $listening = yes ]; then
        say "preflight ok: $NAME started ($START) and listened on $port"
        rm -f "$log"
    else
        echo "--- $START, in $dir:" >&2; tail -20 "$log" >&2; rm -f "$log"
        die "preflight FAILED: $NAME ${port:+reported port $port but was not listening}${port:-never reported a port within ${TIMEOUT}s}"
    fi
}

do_status() {
    [ -e "$LINK" ] || die "$LINK does not exist"
    if [ ! -L "$LINK" ]; then say "$LINK is a plain directory (not adopted yet; install or activate adopts it)"; return; fi
    local cur prev live; cur=$(current); prev=$(cat "$REL/.previous" 2>/dev/null || true); live=$(live_releases)
    echo "$LINK -> $(readlink "$LINK")"
    for d in $(ls -1t "$REL" 2>/dev/null); do
        [ -d "$REL/$d" ] || continue
        case "$d" in .incoming-*) continue ;; esac
        local tags=""
        [ "$d" = "$cur" ] && tags="$tags current"
        [ "$d" = "$prev" ] && tags="$tags previous"
        if echo "$live" | grep -qx "$d"; then
            # readlink fails for processes that end mid-walk; under pipefail that must not count.
            local n; n=$( (for p in /proc/[0-9]*; do readlink "$p/cwd" 2>/dev/null || true; done) | grep -c "/$d\(/\|$\)" || true)
            tags="$tags live($n)"
        fi
        printf '  %-32s%s\n' "$d" "$tags"
    done
}

do_prune() {
    [ -L "$LINK" ] || die "$LINK is not a release link yet"
    local cur prev live kept=0; cur=$(current); prev=$(cat "$REL/.previous" 2>/dev/null || true); live=$(live_releases)
    for d in $(ls -1t "$REL"); do
        [ -d "$REL/$d" ] || continue
        case "$d" in .incoming-*) continue ;; esac
        if [ "$d" = "$cur" ] || [ "$d" = "$prev" ]; then continue; fi
        if echo "$live" | grep -qx "$d"; then say "keeping $d: a match is running in it"; continue; fi
        kept=$((kept + 1))
        [ $kept -le "$KEEP" ] && continue
        rm -rf "${REL:?}/$d"; history "prune $d"; say "pruned $d"
    done
}

case "$CMD" in
    status)    do_status ;;
    install)   do_install ;;
    preflight) do_preflight ;;
    activate)  adopt; [ $PREFLIGHT = 0 ] || do_preflight; switch_to "$NAME" ;;
    deploy)    do_install; [ $PREFLIGHT = 0 ] || do_preflight; switch_to "$NAME" ;;
    rollback)  prev=$(cat "$REL/.previous" 2>/dev/null) || die "no previous release recorded"; switch_to "$prev" ;;
    prune)     do_prune ;;
    *)         die "unknown command $CMD" ;;
esac
