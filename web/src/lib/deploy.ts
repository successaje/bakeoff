/**
 * Deploying a challenge from the owner's wallet, in one transaction.
 *
 * The transaction is the owner's to sign, to a new sub-account of theirs:
 *
 *   CreateAccount → Transfer (its storage) → DeployContract → FunctionCall new(...)
 *
 * NEAR applies a transaction's actions together or not at all, so if `new` rejects the
 * arguments, the account is never created and the deposit returns. No access key is added: the
 * challenge account is locked from the moment it exists, so nobody, its owner included, can
 * change its code or sign as it. The owner's own calls (fund, open, withdraw) come from the
 * owner's account, and payouts are sent by the contract itself.
 *
 * What stays on the owner's machine is what has to: the hidden test set and the model API key,
 * which scripts/near/store-secrets.sh encrypts for the evaluator. The deployment record written
 * here is what that script and scripts/near/submit.sh read.
 */

import type { Network } from "./near.ts";
import { sha256Hex } from "./near.ts";
import type { Transaction } from "./transactions.ts";

/**
 * The contract the board deploys: the same build as the testnet challenges opened since
 * 2026-11-13, whose accounts report this code hash. The board checks the bytes it serves
 * against it before asking the wallet to deploy them.
 */
export const CONTRACT = {
  path: "contract/bakeoff_contract.wasm",
  bytes: 186_518,
  /** NEAR's code hash: base58 of the SHA-256 of the code. */
  codeHash: "HeXPDJmQgPDfBfYvedbTL3iVyFvX7yZ84NH3s5n3tTGU",
};

/** The evaluator build every Bakeoff challenge pins, and where each network fetches it from. */
export const EVALUATOR: Record<Network, { url: string; sha256: string }> = {
  testnet: {
    url: "https://test.fastfs.io/finishr.testnet/outlayer.testnet/e168863655d99382a4ab5e6fd1d112d47cbfe57c827d44530610eddfab5e4081.wasm",
    sha256: "e168863655d99382a4ab5e6fd1d112d47cbfe57c827d44530610eddfab5e4081",
  },
  mainnet: {
    url: "https://main.fastfs.io/bakeoff.near/outlayer.near/e168863655d99382a4ab5e6fd1d112d47cbfe57c827d44530610eddfab5e4081.wasm",
    sha256: "e168863655d99382a4ab5e6fd1d112d47cbfe57c827d44530610eddfab5e4081",
  },
};

export const OUTLAYER_CONTRACT: Record<Network, string> = { testnet: "outlayer.testnet", mainnet: "outlayer.near" };
/** The OutLayer secrets profile scripts/near/store-secrets.sh writes to. */
export const SECRETS_PROFILE = "bakeoff";

const TGAS = 1_000_000_000_000n;
/** NEAR's storage price: 10^19 yoctoNEAR a byte, 0.01 NEAR a kilobyte. */
const YOCTO_PER_BYTE = 10n ** 19n;
/** The account record and the contract's own state beside the rules, with room to spare. */
const STATE_ALLOWANCE_BYTES = 4_000n;
const CENT = 10n ** 22n;

/**
 * NEAR to send the new account: storage for its code, rules and starting state, rounded up to
 * 0.01 NEAR. A locked account can never be deleted, so anything beyond what it stores stays with
 * it; this sends what it needs, about 1.9 NEAR, where deploy.sh sends 2.5.
 */
export function storageDeposit(codeBytes: number, rulesJson: string): bigint {
  const bytes = BigInt(codeBytes) + BigInt(new TextEncoder().encode(rulesJson).length) + STATE_ALLOWANCE_BYTES;
  const yocto = bytes * YOCTO_PER_BYTE;
  return ((yocto + CENT - 1n) / CENT) * CENT;
}

export interface DeployInput {
  network: Network;
  owner: string;
  challenge: string;
  rulesJson: string;
  testSetSha256: string;
}

/** The arguments the contract's `new` takes, as scripts/near/deploy.sh builds them. */
export function initArgs({ network, owner, rulesJson, testSetSha256 }: DeployInput): object {
  return {
    owner,
    outlayer: OUTLAYER_CONTRACT[network],
    evaluator: EVALUATOR[network],
    secrets: { profile: SECRETS_PROFILE, owner },
    rules_json: rulesJson,
    test_set_sha256: testSetSha256,
  };
}

/** The one transaction that creates, funds, deploys and initialises the challenge. */
export function deployTransaction(input: DeployInput, code: Uint8Array): Transaction {
  return {
    receiverId: input.challenge,
    actions: [
      { type: "CreateAccount" },
      { type: "Transfer", params: { deposit: String(storageDeposit(code.length, input.rulesJson)) } },
      { type: "DeployContract", params: { code } },
      { type: "FunctionCall", params: { methodName: "new", args: initArgs(input), gas: String(100n * TGAS), deposit: "0" } },
    ],
  };
}

/**
 * The deployment record, as scripts/near/deploy.sh writes it to .deploy/<network>.env. Saved
 * there, it lets store-secrets.sh seal this challenge's test set and key, and submit.sh run
 * trials, exactly as for a challenge deployed from the command line.
 */
export function deploymentRecord(input: DeployInput, files: { rules: string; testSet: string }): string {
  const evaluator = EVALUATOR[input.network];
  return [
    `# Deployed from the Bakeoff board's setup form; save as .deploy/${input.network}.env`,
    `CHALLENGE=${input.challenge}`,
    `OUTLAYER=${OUTLAYER_CONTRACT[input.network]}`,
    `SECRETS_PROFILE=${SECRETS_PROFILE}`,
    `EVALUATOR_URL=${evaluator.url}`,
    `EVALUATOR_SHA256=${evaluator.sha256}`,
    `RULES_FILE=${files.rules}`,
    `TEST_SET_FILE=${files.testSet}`,
    `TEST_SET_SHA256=${input.testSetSha256}`,
    "",
  ].join("\n");
}

/**
 * The hash the contract pins for a test set: SHA-256 of its text with line endings as Python
 * reads them and trailing newlines removed, as deploy.sh and store-secrets.sh compute it.
 */
export function testSetSha256(text: string): Promise<string> {
  return sha256Hex(text.replace(/\r\n?/g, "\n").replace(/\n+$/, ""));
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** NEAR's code hash for some code: base58 of its SHA-256. */
export async function codeHash(code: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", code));
  let n = digest.reduce((acc, byte) => acc * 256n + BigInt(byte), 0n);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of digest) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** Fetches the contract the board serves and refuses it unless it is the pinned build. */
export async function loadContract(fetchImpl: typeof fetch = fetch.bind(globalThis), base = import.meta.env?.BASE_URL ?? "/"): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetchImpl(`${base}${CONTRACT.path}`);
  if (!response.ok) throw new Error(`the contract could not be downloaded (HTTP ${response.status})`);
  const code = new Uint8Array(await response.arrayBuffer());
  const hash = await codeHash(code);
  if (hash !== CONTRACT.codeHash) throw new Error(`the contract the board serves hashes to ${hash}, not the pinned ${CONTRACT.codeHash}`);
  return code;
}
