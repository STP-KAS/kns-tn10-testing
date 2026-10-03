#!/usr/bin/env bash
# KNS TN10 trickle of domain TRANSFERS (stp 21:55 CEST Fri 2 Oct): random op every 2-6 s, 1.0x /tmp/r6-feerate, from the funded-2026-10-02 dust.
# Disarmed while ./STOP exists. Stop any time: touch /workspace/artifacts/kns-tn10/trickle-2026-10-02/STOP (in-flight reveal finishes, summary.json written).
# Extra args are passed to trickle.mjs (e.g. --max-ops 1 for a single test transfer).
set -euo pipefail
D=/workspace/artifacts/kns-tn10/trickle-2026-10-02; cd "$D"
[ -e "$D/STOP" ] && { echo "disarmed: $D/STOP exists"; exit 1; }
[ -e /workspace/artifacts/stress-tests/STOP ] && { echo "storm STOP present; not starting"; exit 1; }
[ "${KNS_TRICKLE_GO:-}" = "1" ] || { echo "set KNS_TRICKLE_GO=1"; exit 1; }
if ps -eo args | grep -q "[t]rickle-2026-10-02/trickle.mjs --broadcast"; then echo "already running"; exit 1; fi
IO=""; command -v ionice >/dev/null && IO="ionice -c3"
nohup $IO nice -n 19 node "$D/trickle.mjs" --broadcast 1 --node ws://127.0.0.1:17210 --min-interval-ms ${TRICKLE_MIN_IV:-25} --max-interval-ms ${TRICKLE_MAX_IV:-108} --feerate-margin ${TRICKLE_MARGIN:-3.0} --max-unconfirmed 400 --watch-sample 0.1 --name-cooldown-min 9 --max-errors-10min 100 --until 2026-10-03T09:00:00+02:00 "$@" >> "$D/trickle.out" 2>&1 &
RPID=$!
if ! ps -eo args | grep -q "[t]ools/watchdog.py"; then nohup $IO nice -n 19 python3 "$D/tools/watchdog.py" ${TRICKLE_MARGIN:-3.0} >> "$D/watchdog.out" 2>&1 & echo "watchdog pid $!"; fi
echo "started pid $RPID (log $D/trickle.out, events $D/events.jsonl, transfers $D/transfers.jsonl)"
