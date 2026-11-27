/**
 * Challenges their owners listed on-chain in the Bakeoff listing registry (registry/ in the
 * repository), as the board shows them. Bakeoff has not reviewed them: the registry only checks
 * that the caller is the account a challenge was created under, and this server only that the
 * account runs a Bakeoff challenge build. Their rules and evaluator build are the owner's choice,
 * so practice runs on them are limited to builds and endpoints Bakeoff knows (`practiceRunRefusal`).
 */

import type { ChallengeConfig, Network } from "./config.ts";
import type { ChallengeView, NearRpc } from "./near.ts";

/** The listing registry on each network where one is deployed, as the board reads it. */
export const LISTING_REGISTRY: Partial<Record<Network, string>> = {
  testnet: "registry.finishr.testnet",
};

/** Builds of the Bakeoff challenge contract, by NEAR code hash, as the board accepts them. */
export const CHALLENGE_CODE_HASHES = [
  "BRtk1Lbh4vHb92f97678AbwyXpS92XS6sKPDJqmbRrDF",
  "HeXPDJmQgPDfBfYvedbTL3iVyFvX7yZ84NH3s5n3tTGU",
  "FsqcVHi64uFDznY3Vycqo2DgfZtMt9TYGumbNhx3XPu7",
];

/**
 * Evaluator builds the board deploys challenges with, by SHA-256. Each sends the NEAR AI key only to
 * the endpoint the rules name, and to that endpoint's host for attestation.
 */
export const KNOWN_EVALUATORS = [
  "c4d75cb773a251f83a5f519c8bf496ba3933d75ee56ed985f45216d6da7e43b0",
  "e168863655d99382a4ab5e6fd1d112d47cbfe57c827d44530610eddfab5e4081",
];

/** Where a self-listed challenge's practice run may send the contributor's key. */
export const NEAR_AI_ORIGIN = "https://cloud-api.near.ai";

interface RegistryListing {
  challenge: string;
  owner: string;
  listing: { practice_set: string | null; labeling_guide: string | null };
}

/** The challenges listed in `registry` whose accounts run a Bakeoff challenge build, in listing order. */
export async function selfListedChallenges(registry: string, rpc: Pick<NearRpc, "view" | "codeHash">): Promise<ChallengeConfig[]> {
  const listed: RegistryListing[] = [];
  for (let from = 0; ; from += 100) {
    const page = await rpc.view<RegistryListing[]>(registry, "get_listings", { from_index: from, limit: 100 });
    listed.push(...page);
    if (page.length < 100) break;
  }
  const genuine = await Promise.all(
    listed.map(async (l) => (CHALLENGE_CODE_HASHES.includes(await rpc.codeHash(l.challenge).catch(() => "")) ? l : null)),
  );
  return genuine
    .filter((l): l is RegistryListing => l !== null)
    .map(({ challenge, owner, listing }) => ({
      id: challenge,
      practiceSet: httpsOnly(listing.practice_set),
      labelingGuide: httpsOnly(listing.labeling_guide),
      listedBy: owner,
    }));
}

/**
 * The registry contract accepts only https links. Anything else is dropped, so a registry named
 * with BAKEOFF_LISTING_REGISTRY cannot point this server at a file on the contributor's machine.
 */
function httpsOnly(link: string | null): string | undefined {
  return link && /^https:\/\//.test(link) ? link : undefined;
}

/** The board's challenges first; a self-listed challenge is added unless the board lists it. */
export function mergeChallenges(board: ChallengeConfig[], selfListed: ChallengeConfig[]): ChallengeConfig[] {
  const known = new Set(board.map((c) => c.id));
  return [...board, ...selfListed.filter((c) => !known.has(c.id))];
}

/**
 * Why a practice run on a self-listed challenge would not be safe with the contributor's key, or
 * null when it is: the challenge must pin an evaluator build Bakeoff knows, and its rules must send
 * model calls to NEAR AI Cloud.
 */
export function practiceRunRefusal(challenge: ChallengeConfig, view: ChallengeView): string | null {
  if (!challenge.listedBy) return null;
  if (!KNOWN_EVALUATORS.includes(view.evaluator.sha256)) {
    return `${challenge.id} is self-listed and pins evaluator ${view.evaluator.sha256}, which is not a Bakeoff build, so it will not be run with your NEAR AI key`;
  }
  let endpoint: string;
  try {
    endpoint = (JSON.parse(view.rules_json) as { endpoint?: string }).endpoint ?? "";
  } catch {
    endpoint = "";
  }
  if (!URL.canParse(endpoint) || new URL(endpoint).origin !== NEAR_AI_ORIGIN) {
    return `${challenge.id} is self-listed and its rules send model calls to ${endpoint || "an unreadable endpoint"}, not ${NEAR_AI_ORIGIN}, so it will not be run with your NEAR AI key`;
  }
  return null;
}
