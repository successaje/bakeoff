/**
 * The setup form's last step: deploying the challenge from the owner's wallet in one approval.
 * The test set is hashed in the browser and never uploaded; sealing it with the model key stays
 * a script on the owner's machine, which reads the deployment record this step hands over.
 */

import { useState } from "react";
import { Link } from "react-router";
import { rpcFor } from "../lib/data.ts";
import { CONTRACT, deploymentRecord, deployTransaction, type DeployInput, loadContract, storageDeposit, testSetSha256 } from "../lib/deploy.ts";
import { formatNear, type Network } from "../lib/near.ts";
import { useSession } from "../lib/session.tsx";
import { suffix, TEST_SET_PATH } from "../lib/setup.ts";
import { Check, Download, Lock, Wallet } from "./Icons.tsx";
import { ActionButton, CodeBlock } from "./ui.tsx";

interface Props {
  network: Network;
  owner: string;
  challenge: string;
  rulesJson: string;
  /** True when the form has nothing left to fix. */
  ready: boolean;
  onOwner: (account: string) => void;
  onDownload: (name: string, text: string) => void;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function WalletDeploy({ network, owner, challenge, rulesJson, ready, onOwner, onDownload }: Props) {
  const session = useSession();
  const [hash, setHash] = useState("");
  const [hashSource, setHashSource] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [deployed, setDeployed] = useState<{ input: DeployInput; locked: boolean } | null>(null);
  const deposit = storageDeposit(CONTRACT.bytes, rulesJson);
  const hashOk = HEX64.test(hash);

  const checks = [
    { ok: ready, text: "The form has nothing left to fix", fix: null },
    { ok: hashOk, text: "The hidden test set's hash", fix: null },
    {
      ok: session.network === network,
      text: `The board is on ${network}`,
      fix: session.network !== network ? <button type="button" className="link-button small" onClick={() => session.setNetwork(network)}>Switch to {network}</button> : null,
    },
    {
      ok: Boolean(session.account) && session.account === owner,
      text: owner ? `Your wallet is connected as ${owner}` : "Your wallet is connected as the owner",
      fix: session.network !== network ? null
        : !session.account ? <button type="button" className="link-button small" onClick={() => void session.signIn()}>Connect wallet</button>
        : session.account !== owner && session.account.endsWith(suffix(network)) ? <button type="button" className="link-button small" onClick={() => onOwner(session.account!)}>Make {session.account} the owner</button>
        : session.account !== owner ? <span className="small muted">Connected as {session.account}, which is not a {network} account.</span>
        : null,
    },
  ];
  const canDeploy = checks.every((c) => c.ok) && (network !== "mainnet" || consent);

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setHash(await testSetSha256(await file.text()));
    setHashSource(file.name);
  };

  const deploy = async () => {
    const input: DeployInput = { network, owner, challenge, rulesJson, testSetSha256: hash };
    const code = await loadContract();
    await session.send([deployTransaction(input, code)]);
    // Read the challenge back once the deployment is final, and confirm it has no keys.
    const rpc = rpcFor(network);
    let view = null;
    for (let i = 0; i < 6 && !view; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      view = await rpc.getChallenge(challenge).catch(() => null);
    }
    if (!view) throw new Error(`the wallet sent the deployment, but ${challenge} could not be read back yet; check its page in a minute`);
    const keys = await rpc.accessKeys(challenge).catch(() => null);
    setDeployed({ input, locked: keys !== null && keys.length === 0 });
    return `${challenge} is deployed${keys?.length === 0 ? " and locked: it has no keys" : ""}.`;
  };

  if (deployed) {
    const record = deploymentRecord(deployed.input, { rules: "rules.json", testSet: TEST_SET_PATH });
    return (
      <div className="deploy-done">
        <p className="setup-ok"><Check /> {challenge} is deployed{deployed.locked ? ", with no keys: it is locked" : ""}.</p>
        <ol className="setup-next">
          <li><span className="mono">1</span><div><strong>Save the deployment record</strong><p className="small text-2">Save it as <span className="mono">.deploy/{network}.env</span> in your clone of the repository, so the scripts know this challenge.</p><button type="button" className="btn btn-sm" onClick={() => onDownload(`${network}.env`, record)}><Download /> {network}.env</button></div></li>
          <li><span className="mono">2</span><div><strong>Seal the test cases and your key</strong><p className="small text-2">With <span className="mono">{TEST_SET_PATH}</span> and your NEAR AI Cloud key in <span className="mono">.env</span>, on your machine:</p><CodeBlock code={`NETWORK=${network} scripts/near/store-secrets.sh`} /></div></li>
          <li><span className="mono">3</span><div><strong>Fund and open it</strong><p className="small text-2">On <Link to={`/challenges/${challenge}`}>its page</Link>, in Manage. There is nothing to lock: it already is.</p></div></li>
        </ol>
      </div>
    );
  }

  return (
    <div className="deploy">
      <div className="setup-field">
        <span className="setup-label">The hidden test set's hash</span>
        <div className="deploy-hash">
          <label className="btn btn-sm deploy-file">
            Choose the file
            <input type="file" accept=".json,application/json" onChange={(e) => void readFile(e.target.files?.[0])} />
          </label>
          <input className="input mono" value={hash} onChange={(e) => { setHash(e.target.value.trim().toLowerCase()); setHashSource(null); }} placeholder="or paste its SHA-256" spellCheck={false} aria-label="Test set SHA-256" />
        </div>
        <span className="setup-hint">
          {hashSource ? <>Hashed <span className="mono">{hashSource}</span> here, in your browser. It was not uploaded.</>
            : <>The file is hashed in your browser and never uploaded, the way <span className="mono">deploy.sh</span> hashes it. The contract pins the hash, so only this test set can score.</>}
          {hash && !hashOk && <span className="setup-error"> A SHA-256 is 64 hex characters.</span>}
        </span>
      </div>

      <ul className="deploy-checks">
        {checks.map((c) => (
          <li key={c.text} className={c.ok ? "ok" : ""}><span className="deploy-mark" aria-hidden="true">{c.ok ? <Check /> : ""}</span><span className="small">{c.text}</span>{!c.ok && c.fix}</li>
        ))}
      </ul>

      <p className="small text-2 deploy-terms"><Lock /> The account gets no keys, so it is locked from the start: nobody, you included, can change or delete it, and the {formatNear(deposit)} it stores stays with it. A wallet that opens in a new page may refuse a 182 KB contract; browser-extension wallets take it.</p>
      {network === "mainnet" && (
        <label className="setup-check deploy-consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span className="small">I understand this spends {formatNear(deposit)} of real NEAR from {owner || "my account"}, for good.</span>
        </label>
      )}
      <ActionButton primary disabled={!canDeploy} label={<><Wallet /> Deploy {challenge || "the challenge"}</>} run={deploy} />
    </div>
  );
}
