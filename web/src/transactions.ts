/**
 * The transactions a sponsor signs, built as NEAR Connect expects them.
 * Gas covers each call and the callbacks it schedules.
 */

export interface FunctionCall {
  type: "FunctionCall";
  params: { methodName: string; args: object; gas: string; deposit: string };
}

export interface Transaction {
  receiverId: string;
  actions: FunctionCall[];
}

const TGAS = 1_000_000_000_000n;
/** wrap.near and wrap.testnet ask for this much to register an account. */
export const WNEAR_STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;

function call(receiverId: string, methodName: string, args: object, tgas: bigint, deposit: bigint): Transaction {
  return {
    receiverId,
    actions: [{ type: "FunctionCall", params: { methodName, args, gas: String(tgas * TGAS), deposit: String(deposit) } }],
  };
}

export const fund = (challenge: string, yocto: bigint) => call(challenge, "fund", {}, 30n, yocto);

/** `closesAt` in milliseconds since the epoch; the contract takes nanoseconds. */
export const open = (challenge: string, closesAt: number) =>
  call(challenge, "open", { closes_at: String(BigInt(closesAt) * 1_000_000n) }, 30n, 0n);

export const withdrawBounty = (challenge: string) => call(challenge, "withdraw_bounty", {}, 50n, 0n);

export const claimAward = (challenge: string) => call(challenge, "claim_award", {}, 50n, 0n);

/** Registers `accountId` with the wNEAR contract so it can receive wNEAR. */
export const registerWnear = (wrap: string, accountId: string) =>
  call(wrap, "storage_deposit", { account_id: accountId, registration_only: true }, 10n, WNEAR_STORAGE_DEPOSIT);

/**
 * Turns wNEAR the sponsor holds, such as a 1Click delivery, into bounty:
 * unwrap it to NEAR, then fund the challenge with it. One wallet approval.
 */
export const unwrapAndFund = (wrap: string, challenge: string, yocto: bigint): Transaction[] => [
  call(wrap, "near_withdraw", { amount: String(yocto) }, 10n, 1n),
  fund(challenge, yocto),
];
