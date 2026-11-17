/**
 * Where a won reward stands. A winner is paid in NEAR with the verdict, or,
 * if they asked for it where the challenge allows, as wNEAR into their NEAR
 * Intents balance, sent by a claim any account can make. A deposit the
 * Intents verifier refuses comes back to the contract and is paid as NEAR.
 */

import { type Award, formatNear } from "./near.ts";

export type AwardStage =
  /** `intents` went into NEAR Intents, `near` as NEAR, and `fee` to registering with wrap.near. */
  | { stage: "paid"; intents: bigint; near: bigint; fee: bigint }
  | { stage: "sending"; intents: boolean }
  /** The winner asked for NEAR Intents; any account can send it. */
  | { stage: "to-intents"; amount: bigint }
  /** Owed as NEAR: a transfer failed, or NEAR Intents refused the deposit. */
  | { stage: "owed"; amount: bigint; refused: boolean };

const yocto = (value?: string) => BigInt(value ?? "0");

export function awardStage(award: Award): AwardStage {
  const intents = yocto(award.to_intents);
  const fee = yocto(award.fee);
  const rest = yocto(award.amount) - intents - fee;
  if (award.paid) return { stage: "paid", intents, near: rest, fee };
  if (award.in_flight) return { stage: "sending", intents: award.payout === "Intents" };
  if (award.payout === "Intents") return { stage: "to-intents", amount: rest };
  // A registration was paid only if the deposit reached the verifier, which then refused some.
  return { stage: "owed", amount: rest, refused: fee > 0n };
}

/**
 * Gas for `claim_award`: the contract asks 160 Tgas to send into NEAR
 * Intents, and unwrapping a refused deposit schedules two more calls.
 */
export function claimTgas(award: Award): bigint {
  if (award.payout === "Intents") return 200n;
  return yocto(award.wrapped) > 0n ? 100n : 50n;
}

/** What the result page says about a won reward. */
export function rewardText(award: Award): { done: boolean; text: string; note?: string } {
  const s = awardStage(award);
  const registration = (fee: bigint) => `${formatNear(fee)} went to registering the contract with the wNEAR token.`;
  switch (s.stage) {
    case "paid":
      if (s.intents > 0n && s.near > 0n) {
        return { done: true, text: `Paid: ${formatNear(s.intents)} into NEAR Intents and ${formatNear(s.near)} as NEAR`, note: registration(s.fee) };
      }
      if (s.intents > 0n) return { done: true, text: "Paid into the winner's NEAR Intents balance, as wNEAR", note: registration(s.fee) };
      if (s.fee > 0n) return { done: true, text: "Paid as NEAR, after NEAR Intents refused the deposit", note: registration(s.fee) };
      return { done: true, text: "Paid by the contract with this result" };
    case "sending":
      return { done: false, text: s.intents ? "Won; the deposit into NEAR Intents is on its way" : "Won; the payment is on its way" };
    case "to-intents":
      return {
        done: false,
        text: "Won; to be paid into the winner's NEAR Intents balance",
        note: "Any connected wallet can send it, and the contract pays only the winner. wrap.near keeps 0.00125 NEAR to register the contract.",
      };
    case "owed":
      return { done: false, text: s.refused ? "Won; NEAR Intents refused the deposit, so it is owed as NEAR" : "Won; the payment has not completed" };
  }
}
