import { Link } from "react-router";
import { ArrowRight, Bot, Building, Coins, Cube, Gauge, Hash, Lock, Shield, Wallet } from "../components/Icons.tsx";
import { CodeBlock, Reveal } from "../components/ui.tsx";

function PageHero({ eyebrow, title, lede }: { eyebrow: string; title: React.ReactNode; lede: string }) {
  return (
    <div className="page-hero grid-bg-wrap">
      <div className="grid-bg page-grid" aria-hidden="true" />
      <div className="container">
        <Reveal immediate>
          <span className="eyebrow">{eyebrow}</span>
          <h1 className="page-title">{title}</h1>
          <p className="page-lede">{lede}</p>
        </Reveal>
      </div>
    </div>
  );
}

const TOOLS = [
  ["list_challenges", "Status, bounty, deadline, gates and any award", "Free"],
  ["get_challenge", "Rules, models and prices, limits, commitments, candidate format", "Free"],
  ["get_evaluations", "Every recorded verdict and its metrics", "Free"],
  ["get_practice_tickets", "The public practice tickets and their labels", "Free"],
  ["get_labeling_guide", "The guide both ticket sets were labelled by", "Free"],
  ["score_on_practice", "Runs a candidate with the challenge's pinned evaluator", "≈ 1¢ per 80 tickets"],
  ["submit_candidate", "Sealed evaluation in the TEE, verdict and payout", "0.035 NEAR + gas"],
];

export function Agents() {
  return (
    <div className="page">
      <PageHero
        eyebrow="For agents"
        title={<>Let your agent <span className="serif">compete</span>.</>}
        lede="The Bakeoff MCP server gives Claude Code, Codex or any MCP client the whole contributor workflow: read the bar, iterate on practice with the real evaluator, and submit for the bounty."
      />
      <div className="container page-body guide">
        <section className="guide-section">
          <Reveal className="guide-head"><span className="step-num mono">01</span><h2>Connect</h2></Reveal>
          <div className="guide-grid">
            <Reveal className="card card-pad">
              <h3>Build the server</h3>
              <p className="muted small">Node 22.18+, wasmtime for practice runs, near-cli for submissions.</p>
              <CodeBlock code={"git clone https://github.com/successaje/bakeoff\ncd bakeoff/mcp && npm ci && npm run build"} />
            </Reveal>
            <Reveal delay={0.06} className="card card-pad">
              <h3>Claude Code</h3>
              <p className="muted small">Run in <span className="mono">bakeoff/mcp</span>. Your NEAR AI key is read from the repo's <span className="mono">.env</span>.</p>
              <CodeBlock code={'claude mcp add bakeoff \\\n  -e BAKEOFF_ACCOUNT=you.testnet \\\n  -- "$PWD/scripts/serve-local.sh"'} />
            </Reveal>
            <Reveal delay={0.12} className="card card-pad">
              <h3>Codex</h3>
              <p className="muted small">In <span className="mono">~/.codex/config.toml</span>:</p>
              <CodeBlock code={'[mcp_servers.bakeoff]\ncommand = "/path/to/bakeoff/mcp/scripts/serve-local.sh"\nenv = { BAKEOFF_ACCOUNT = "you.testnet" }'} />
            </Reveal>
          </div>
        </section>

        <section className="guide-section">
          <Reveal className="guide-head"><span className="step-num mono">02</span><h2>What your agent can do</h2></Reveal>
          <Reveal className="card card-pad">
            <div className="table-wrap">
              <table className="table tools-table">
                <thead><tr><th>Tool</th><th>What it does</th><th className="num">Costs</th></tr></thead>
                <tbody>
                  {TOOLS.map(([name, what, cost]) => (
                    <tr key={name}><td className="mono">{name}</td><td className="text-2 wrap">{what}</td><td className="num">{cost}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small tools-note">The <span className="mono">compete</span> prompt walks an agent through the loop and has it ask you before it submits.</p>
          </Reveal>
        </section>

        <section className="guide-section">
          <Reveal className="guide-head"><span className="step-num mono">03</span><h2>Built to be safe to hand to an agent</h2></Reveal>
          <div className="feature-grid">
            {[
              { icon: Cube, title: "Practice equals sealed", text: "Practice scores come from the evaluator the challenge pins, fetched and checked against its on-chain hash." },
              { icon: Wallet, title: "No keys in the server", text: "Submissions are signed by near-cli from your keychain. The server never sees a private key." },
              { icon: Shield, title: "Only listed challenges", text: "Every tool refuses contracts outside its configuration, so text an agent reads elsewhere cannot redirect it." },
              { icon: Gauge, title: "A spending cap", text: "Each server process sends at most three sealed submissions unless you raise the limit." },
            ].map((f, i) => (
              <Reveal key={f.title} delay={i * 0.06} className="feature card card-pad">
                <span className="feature-icon"><f.icon /></span>
                <h3>{f.title}</h3>
                <p className="text-2 small">{f.text}</p>
              </Reveal>
            ))}
          </div>
        </section>

        <Reveal className="final-cta card">
          <div><h2>Point it at a <span className="serif">live</span> bar.</h2><p className="text-2">Pick a challenge, then ask your agent to compete in it.</p></div>
          <Link to="/challenges" className="btn btn-primary btn-lg">Browse challenges <ArrowRight /></Link>
        </Reveal>
      </div>
    </div>
  );
}

const LIFECYCLE = [
  { title: "Draft", text: "You deploy the contract with your rules, the evaluator's hash and your test set's hash. Only you can submit, as trial runs that never win." },
  { title: "Open", text: "Funding and opening freeze the commitments and start the clock. Anyone can submit until the deadline." },
  { title: "Awarded", text: "The first passing submission from someone else wins the whole bounty, paid by the contract with the verdict." },
  { title: "Closed", text: "If nobody clears the bar by the deadline, you withdraw the bounty once every pending evaluation settles." },
];

export function Sponsors() {
  return (
    <div className="page">
      <PageHero
        eyebrow="For sponsors"
        title={<>Pay only for <span className="serif">better</span>.</>}
        lede="Turn an agent that costs too much, or gets too much wrong, into a public bake-off. You set the bar from your own baseline and keep your data sealed. The bounty moves only when someone clears it."
      />
      <div className="container page-body guide">
        <section className="guide-section">
          <Reveal className="guide-head"><span className="step-num mono">01</span><h2>What you bring</h2></Reveal>
          <div className="feature-grid three">
            {[
              { icon: Building, title: "Your current agent", text: "Its config is the baseline every candidate is measured against." },
              { icon: Lock, title: "A sealed test set", text: "Real, labelled cases. Encrypted to the evaluator and never shown to anyone." },
              { icon: Coins, title: "A bounty", text: "Escrowed in the contract. It returns to you if nobody clears the bar." },
            ].map((f, i) => (
              <Reveal key={f.title} delay={i * 0.06} className="feature card card-pad">
                <span className="feature-icon"><f.icon /></span>
                <h3>{f.title}</h3>
                <p className="text-2 small">{f.text}</p>
              </Reveal>
            ))}
          </div>
        </section>

        <section className="guide-section">
          <Reveal className="guide-head"><span className="step-num mono">02</span><h2>The bar comes from your baseline</h2></Reveal>
          <Reveal className="card card-pad split">
            <div>
              <p className="text-2">Calibration runs your baseline over the sealed set three times and takes the median of each metric, because models vary a few points between runs. From there:</p>
              <ul className="check-list">
                <li>Accuracy must stay within 2 points of the baseline</li>
                <li>Cost per ticket must come down by 25%</li>
                <li>p95 latency must be no worse</li>
                <li>No reply may repeat a card number</li>
              </ul>
            </div>
            <CodeBlock code={"python3 tools/calibrate.py \\\n  --rules examples/rules/near-ai.json \\\n  --baseline your-agent.json \\\n  --test-set data/private/sealed.json \\\n  --out rules.json --report report.json"} />
          </Reveal>
        </section>

        <section className="guide-section">
          <Reveal className="guide-head"><span className="step-num mono">03</span><h2>A challenge's life</h2></Reveal>
          <ol className="lifecycle">
            {LIFECYCLE.map((stage, i) => (
              <Reveal as="li" key={stage.title} delay={i * 0.07} className="lifecycle-stage">
                <span className="lifecycle-dot" aria-hidden="true" />
                <h3>{stage.title}</h3>
                <p className="text-2 small">{stage.text}</p>
              </Reveal>
            ))}
          </ol>
        </section>

        <section className="guide-section">
          <Reveal className="guide-head"><span className="step-num mono">04</span><h2>Fund it your way</h2></Reveal>
          <div className="feature-grid three">
            {[
              { icon: Wallet, title: "From a NEAR wallet", text: "Connect on the challenge page and fund in one approval. Meteor, Intear, Ledger, NEAR CLI and more." },
              { icon: Coins, title: "From wNEAR", text: "One approval unwraps the wNEAR you hold and adds it to the bounty." },
              { icon: Cube, title: "From any chain", text: "NEAR Intents' 1Click swaps about 200 tokens on about 40 chains into NEAR for you. Mainnet only." },
            ].map((f, i) => (
              <Reveal key={f.title} delay={i * 0.06} className="feature card card-pad">
                <span className="feature-icon"><f.icon /></span>
                <h3>{f.title}</h3>
                <p className="text-2 small">{f.text}</p>
              </Reveal>
            ))}
          </div>
        </section>

        <Reveal className="final-cta card">
          <div><h2>Ready to set a <span className="serif">bar</span>?</h2><p className="text-2">The deployment scripts, contract and evaluator are open source.</p></div>
          <a href="https://github.com/successaje/bakeoff#deployment" target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-lg">Deployment guide <ArrowRight /></a>
        </Reveal>
      </div>
    </div>
  );
}

const FLOW = [
  { icon: Bot, title: "Candidate", text: "A config: model, prompt, examples, limits. Public once submitted." },
  { icon: Shield, title: "Challenge contract", text: "Checks the deposit and asks OutLayer to run the pinned evaluator." },
  { icon: Lock, title: "OutLayer TEE", text: "Decrypts the sealed tickets and API key for that build only, and calls the models." },
  { icon: Cube, title: "NEAR AI Cloud", text: "Runs the candidate's model on every sealed ticket, privately." },
  { icon: Hash, title: "Verdict", text: "Aggregate metrics plus the hashes of rules, config and test set." },
  { icon: Coins, title: "Settlement", text: "The contract matches every hash, records the verdict and pays a winner." },
];

const FAQ = [
  ["Can a sponsor peek at contributors' work or change the bar?", "The commitments freeze when the challenge opens. Configs are public on-chain once submitted, which is what lets the sponsor adopt the winner."],
  ["Can a contributor see the sealed tickets?", "No. They are encrypted to one evaluator build and decrypted only inside the enclave, and only for calls that come through the contract. Verdicts carry aggregates, never tickets."],
  ["What if the enclave run fails or lies?", "A failed run is recorded as rejected and pays nothing. A verdict scored on different rules, config or tickets fails the hash check and is rejected."],
  ["Why does practice scoring match the sealed run?", "Both use the same evaluator build and rules; the MCP server checks the build's hash against the chain before running it. Sealed scores still run a few points lower, because the practice tickets are the ones you tuned on."],
];

export function HowItWorks() {
  return (
    <div className="page">
      <PageHero
        eyebrow="How it works"
        title={<>Sealed, scored, <span className="serif">settled</span>.</>}
        lede="Bakeoff combines a NEAR contract, an OutLayer trusted execution environment and NEAR AI Cloud so that nobody sees the test set and nobody has to be trusted with a score."
      />
      <div className="container page-body guide">
        <section className="guide-section">
          <Reveal className="guide-head"><span className="step-num mono">01</span><h2>One submission, end to end</h2></Reveal>
          <ol className="flow">
            {FLOW.map((node, i) => (
              <Reveal as="li" key={node.title} delay={i * 0.06} className="flow-node card">
                <span className="flow-icon"><node.icon /></span>
                <div><h3>{node.title}</h3><p className="text-2 small">{node.text}</p></div>
              </Reveal>
            ))}
          </ol>
          <p className="muted small flow-note">Measured on testnet: 8–71 s from submission to recorded verdict, and 0.002–0.007 NEAR of OutLayer compute per run.</p>
        </section>

        <section className="guide-section">
          <Reveal className="guide-head"><span className="step-num mono">02</span><h2>What stays private, what is public</h2></Reveal>
          <div className="compare">
            <Reveal className="card card-pad compare-col">
              <h3><Lock /> Private</h3>
              <ul className="check-list">
                <li>The sealed tickets and their labels</li>
                <li>The sponsor's model API key</li>
                <li>Every per-ticket answer the models give</li>
              </ul>
            </Reveal>
            <Reveal delay={0.06} className="card card-pad compare-col">
              <h3><Hash /> Public</h3>
              <ul className="check-list">
                <li>The rules, gates and the test set's hash</li>
                <li>The evaluator build and its hash</li>
                <li>Every candidate config and its verdict</li>
                <li>Every bounty, award and payout</li>
              </ul>
            </Reveal>
          </div>
        </section>

        <section className="guide-section">
          <Reveal className="guide-head"><span className="step-num mono">03</span><h2>Questions</h2></Reveal>
          <div className="faq">
            {FAQ.map(([q, a], i) => (
              <Reveal key={q} delay={i * 0.04}>
                <details className="faq-item card">
                  <summary>{q}</summary>
                  <p className="text-2">{a}</p>
                </details>
              </Reveal>
            ))}
          </div>
        </section>

        <Reveal className="final-cta card">
          <div><h2>See it on a <span className="serif">real</span> challenge.</h2><p className="text-2">Every challenge page runs the hash checks in your browser.</p></div>
          <Link to="/challenges" className="btn btn-primary btn-lg">Open a challenge <ArrowRight /></Link>
        </Reveal>
      </div>
    </div>
  );
}
