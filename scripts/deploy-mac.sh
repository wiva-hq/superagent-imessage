#!/usr/bin/env bash
# Deploys one commit to the agent's Mac: the self-hosted runner's deploy job calls it, and a person can run it by hand.
#
#   DEPLOY_DIR=~/imsg-superagent STATE_DIR=~/.dsh-superagent scripts/deploy-mac.sh <commit sha>
#
# It follows docs/006-deployment.md, Upgrade: back up the database, check out, install, build, restart and read the status.
# A restart that exits 1 rolls back to the previous commit and restores the backup, because a database migrated by the new
# version cannot be opened by the old one. Status 3 (waiting for setup) and 2 (a part such as a Source reports an error)
# keep the new commit: a restart does not fix them, a person does, so the script says so and fails the job.
#
# Optional: DEPLOY_NOTIFY_CHAT, an iMessage chat id, receives one line about the result through imsg-bridge.
# Optional: DSH_SUPERAGENT_PROFILE (default superagent), passed through to scripts/dsh-superagent.
set -euo pipefail

SHA="${1:?usage: deploy-mac.sh <commit sha>}"
DEPLOY_DIR="${DEPLOY_DIR:?set DEPLOY_DIR to the checkout the service runs from}"
STATE_DIR="${STATE_DIR:?set STATE_DIR to the bundle stateDir}"
PROFILE="${DSH_SUPERAGENT_PROFILE:-superagent}"
BRIDGE="${IMSG_BRIDGE_CLI:-$DEPLOY_DIR/bridge/bin/imsg-bridge}"

log() { printf '[deploy] %s\n' "$*"; }
notify() {
  [[ -n "${DEPLOY_NOTIFY_CHAT:-}" ]] || return 0
  # One key per run and attempt, so a rerun of the same job does not send the same line twice.
  "$BRIDGE" reply --chat "$DEPLOY_NOTIFY_CHAT" --key "deploy-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-$(date +%s)}" --text "$1" >/dev/null \
    || log "could not send the iMessage notice"
}
build() {
  log "installing and building $(git -C "$DEPLOY_DIR" rev-parse --short HEAD)"
  (cd "$DEPLOY_DIR" && pnpm install --frozen-lockfile && pnpm build)
  (cd "$DEPLOY_DIR/bridge" && pnpm install --frozen-lockfile)
}
restart() {
  local code=0
  (cd "$DEPLOY_DIR" && scripts/dsh-superagent --profile "$PROFILE" restart) || code=$?
  return "$code"
}

[[ -d "$DEPLOY_DIR/.git" ]] || { log "$DEPLOY_DIR is not a git checkout"; exit 1; }
if [[ -n "$(git -C "$DEPLOY_DIR" status --porcelain --untracked-files=no)" ]]; then
  log "$DEPLOY_DIR has local changes; commit or stash them first"; exit 1
fi

PREVIOUS="$(git -C "$DEPLOY_DIR" rev-parse HEAD)"
if [[ "$PREVIOUS" == "$SHA" ]]; then log "already at $SHA"; exit 0; fi

BACKUP="$STATE_DIR/backups/orchestrator-$(date +%Y%m%d-%H%M%S)-${PREVIOUS:0:12}.sqlite"
mkdir -p "$STATE_DIR/backups"
if [[ -f "$STATE_DIR/orchestrator.sqlite" ]]; then
  # sqlite3's backup command copies a consistent snapshot even while the service writes.
  sqlite3 "$STATE_DIR/orchestrator.sqlite" ".backup '$BACKUP'"
  log "backed up the database to $BACKUP"
  # Keep the ten newest backups.
  ls -1t "$STATE_DIR"/backups/orchestrator-*.sqlite 2>/dev/null | tail -n +11 | xargs -r rm -f
fi

git -C "$DEPLOY_DIR" fetch --quiet origin
git -C "$DEPLOY_DIR" checkout --quiet --detach "$SHA"
build

code=0; restart || code=$?
case "$code" in
  0) log "deployed ${SHA:0:7}"; notify "Deployed imsg-superagent ${SHA:0:7}; status is healthy."; exit 0 ;;
  2|3)
    what=$([[ "$code" == 3 ]] && echo "waits for setup" || echo "runs, but a part reports an error")
    log "deployed ${SHA:0:7}, but the service $what; run scripts/dsh-superagent status"
    notify "Deployed imsg-superagent ${SHA:0:7}, but it $what. Check scripts/dsh-superagent status."
    exit 1 ;;
esac

log "restart failed with exit $code; rolling back to ${PREVIOUS:0:7}"
(cd "$DEPLOY_DIR" && scripts/dsh-superagent --profile "$PROFILE" stop) || true
git -C "$DEPLOY_DIR" checkout --quiet --detach "$PREVIOUS"
[[ -f "${BACKUP}" ]] && cp "$BACKUP" "$STATE_DIR/orchestrator.sqlite" && log "restored $BACKUP"
build
rollback=0; (cd "$DEPLOY_DIR" && scripts/dsh-superagent --profile "$PROFILE" start) || rollback=$?
notify "Deploy of imsg-superagent ${SHA:0:7} failed; rolled back to ${PREVIOUS:0:7} (status $rollback)."
exit 1
