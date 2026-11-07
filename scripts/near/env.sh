# Shared setup for the NEAR scripts. Sourced, not run.
#
# Loads .env without overriding anything the caller already set, so
#   NETWORK=mainnet BAKEOFF_ACCOUNT=you.near scripts/near/deploy.sh
# works alongside a .env written for testnet. Then resolves the network:
# OutLayer's contract, the explorer, and this network's deployment record.
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

if [ -f .env ]; then
  while IFS='=' read -r key value; do
    case "$key" in '' | \#*) continue ;; esac
    [ -z "${!key+set}" ] && export "$key=$value"
  done < .env
fi

NETWORK="${NETWORK:-testnet}"
case "$NETWORK" in
  testnet) OUTLAYER=outlayer.testnet; EXPLORER=https://testnet.nearblocks.io; ACCOUNT_SUFFIX=.testnet ;;
  mainnet) OUTLAYER=outlayer.near; EXPLORER=https://nearblocks.io; ACCOUNT_SUFFIX=.near ;;
  *) echo "NETWORK must be testnet or mainnet, not $NETWORK" >&2; exit 1 ;;
esac
# The OutLayer CLI reads this to pick the network and its saved login.
export OUTLAYER_NETWORK="$NETWORK"
DEPLOY_FILE=".deploy/$NETWORK.env"

if [ -n "${BAKEOFF_ACCOUNT:-}" ] && [[ "$BAKEOFF_ACCOUNT" != *"$ACCOUNT_SUFFIX" ]]; then
  echo "BAKEOFF_ACCOUNT=$BAKEOFF_ACCOUNT is not a $NETWORK account; pass the $NETWORK one, e.g. BAKEOFF_ACCOUNT=you$ACCOUNT_SUFFIX" >&2
  exit 1
fi

# Real money: a mainnet transaction needs the signer named twice.
require_mainnet_confirmation() {
  if [ "$NETWORK" = mainnet ] && [ "${MAINNET_CONFIRM:-}" != "$1" ]; then
    echo "This spends real NEAR from $1 on mainnet. Re-run with MAINNET_CONFIRM=$1 to go ahead." >&2
    exit 1
  fi
}

load_deployment() {
  [ -f "$DEPLOY_FILE" ] || { echo "no $NETWORK deployment yet: run NETWORK=$NETWORK scripts/near/deploy.sh first" >&2; exit 1; }
  # shellcheck disable=SC1090
  . "./$DEPLOY_FILE"
}
