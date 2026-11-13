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
  ["list_challenges", "Status, reward, deadline, requirements and any award", "Free"],
  ["get_challenge", "Rules, models and prices, limits, commitments, solution format", "Free"],
  ["get_evaluations", "Every recorded result and its metrics", "Free"],
  ["get_practice_tickets", "The public practice tickets and their labels", "Free"],
  ["get_labeling_guide", "The guide both ticket sets were labelled by", "Free"],
  ["score_on_practice", "Runs a solution with the challenge's pinned evaluator", "≈ 1¢ per 80 tickets"],
  ["submit_candidate", "The test on hidden cases in the enclave, its result and any payout", "0.035 NEAR + gas"],
];

export function Builders() {
  return (
    <div className="page">
      <PageHero
        eyebrow="For builders"
        title={<>Let your agent <span className="serif">compete</span>.</>}
        lede="The Bakeoff MCP server gives Claude Code, Codex or any MCP client the whole builder workflow: read the goal, iterate on practice cases with the real evaluator, and submit for the reward."
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
              <CodeBlock code={'claude mcp add bakeoff \\\n  -e BAKEOFF_ACCOUNT=you.near \\\n  -e BAKEOFF_NETWORK=mainnet \\\n  -- "$PWD/scripts/serve-local.sh"'} />
            </Reveal>
            <Reveal delay={0.12} className="card card-pad">
              <h3>Codex</h3>
              <p className="muted small">In <span className="mono">~/.codex/config.toml</span>:</p>
              <CodeBlock code={'[mcp_servers.bakeoff]\ncommand = "/path/to/bakeoff/mcp/scripts/serve-local.sh"\nenv = { BAKEOFF_ACCOUNT = "you.near", BAKEOFF_NETWORK = "mainnet" }'} />
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
              { icon: Cube, title: "Practice uses the real evaluator", text: "Practice scores come from the evaluator the challenge pins, fetched and checked against its on-chain hash." },
              { icon: Wallet, title: "No keys in the server", text: "Submissions are signed by near-cli from your keychain. The server never sees a private key." },
              { icon: Shield, title: "Only listed challenges", text: "Every tool refuses contracts outside its configuration, so text an agent reads elsewhere cannot redirect it." },
              { icon: Gauge, title: "A spending cap", text: "Each server process sends at most three submissions unless you raise the limit." },
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
          <div><h2>Point it at a <span className="serif">live</span> goal.</h2><p className="text-2">Pick a challenge, then ask your agent to take part.</p></div>
          <Link to="/challenges" className="btn btn-primary btn-lg">Browse challenges <ArrowRight /></Link>
        </Reveal>
      </div>
    </div>
  );
}

const LIFECYCLE = [
  { title: "Draft", text: "You deploy the contract with your rules, the evaluator's hash and your test set's hash. Only you can submit, as trial runs that never win." },
  { title: "Open", text: "Funding and opening freeze the commitments and start the clock. Anyone can submit until the deadline." },
  { title: "Awarded", text: "The earliest submission from someone else that meets every requirement wins the whole reward, paid by the contract. Results count in the order they were submitted, so copying a pending solution cannot win." },
  { title: "Closed", text: "If nobody meets the requirements by the deadline, you withdraw the reward once every pending result settles." },
];

export function Teams() {
  return (
    <div className="page">
      <PageHero
        eyebrow="For teams"
        title={<>Pay only for <span className="serif">better</span>.</>}
        lede="Turn an AI workflow that costs too much, or gets too much wrong, into a challenge. You set the requirements from your own baseline and keep your test cases hidden from builders. The reward moves only when a result meets them."
      />
      <div className="container page-body guide">
        <section className="guide-section">
          <Reveal className="guide-head"><span className="step-num mono">01</span><h2>What you bring</h2></Reveal>
          <div className="feature-grid three">
            {[
              { icon: Building, title: "Your current agent", text: "Its config is the baseline every solution is measured against." },
              { icon: Lock, title: "Hidden test cases", text: "Real, labelled cases, encrypted to the evaluator and never shown to builders. The model provider processes them during each test." },
              { icon: Coins, title: "A reward", text: "Held by the contract. It returns to you if nobody meets the requirements." },
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
          <Reveal className="guide-head"><span className="step-num mono">02</span><h2>Requirements come from your baseline</h2></Reveal>
          <Reveal className="card card-pad split">
            <div>
              <p className="text-2">Calibration runs your baseline over your hidden test cases three times and takes the median of each metric, because models vary a few points between runs. From there:</p>
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
              { icon: Coins, title: "From wNEAR", text: "One approval unwraps the wNEAR you hold and adds it to the reward." },
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

        <section className="guide-section" id="set-up">
          <Reveal className="guide-head"><span className="step-num mono">05</span><h2>Set up a challenge</h2></Reveal>
          <Reveal className="card card-pad split">
            <div>
              <p className="text-2">Setup runs from the command line, with the open-source scripts. <Link to="/challenges/new">The setup form</Link> writes the rules file, the listing and every command for you. You need:</p>
              <ul className="check-list">
                <li>Your current agent as a config for a NEAR AI Cloud model</li>
                <li>About 100 real cases, labelled the way you want them answered</li>
                <li>A NEAR account with about 3 NEAR, plus the reward</li>
                <li>A NEAR AI Cloud API key, stored with OutLayer so only the evaluator can use it</li>
              </ul>
              <p className="muted small">Deploying costs about 2.5 NEAR, mostly storage you get back by deleting the challenge. Storing the test cases takes a deposit of about 0.25 NEAR. Each test costs about 0.02 NEAR. Once deployed, you fund and open the challenge from its page, in the Manage section.</p>
            </div>
            <CodeBlock code={"python3 tools/calibrate.py --runs 3 ...\nscripts/near/deploy.sh\nscripts/near/store-secrets.sh\nscripts/near/submit.sh your-agent.json   # a trial run"} />
          </Reveal>
        </section>

        <Reveal className="final-cta card">
          <div><h2>Ready to set a <span className="serif">goal</span>?</h2><p className="text-2">The setup form writes your rules file, listing and commands. The scripts, contract and evaluator are open source, and the deployment guide walks through each step.</p></div>
          <div className="final-cta-actions">
            <Link to="/challenges/new" className="btn btn-primary btn-lg">Set up a challenge <ArrowRight /></Link>
            <a href="https://github.com/successaje/bakeoff#deployment" target="_blank" rel="noopener noreferrer" className="btn btn-lg">Deployment guide</a>
          </div>
        </Reveal>
      </div>
    </div>
  );
}

const FLOW = [
  { icon: Bot, title: "Solution", text: "A config: model, prompt, examples, limits. Public once submitted." },
  { icon: Shield, title: "Challenge contract", text: "Checks the deposit and asks OutLayer to run the pinned evaluator." },
  { icon: Lock, title: "OutLayer enclave", text: "Decrypts the hidden test cases and API key for that build only, and calls the models." },
  { icon: Cube, title: "NEAR AI Cloud", text: "Runs the solution's model on every hidden case. The model provider processes each case to answer it." },
  { icon: Hash, title: "Result", text: "Totals, plus the hashes of the rules, the config and the test set." },
  { icon: Coins, title: "Settlement", text: "The contract matches every hash, records the result and pays a winner." },
];

const FAQ = [
  ["Can the owner change the requirements once builders are competing?", "No. The commitments freeze when the challenge opens. Configs are public on-chain once submitted, which is what lets the owner adopt the winner."],
  ["Can a builder see the hidden test cases?", "No. They are encrypted to one evaluator build and decrypted only inside the enclave, and only for calls that come through the contract. Results carry totals, never cases."],
  ["What if the enclave run fails or lies?", "A failed run is recorded as rejected and pays nothing. A result scored on different rules, config or cases fails the hash check and is rejected."],
  ["Why does practice scoring match the test?", "Both use the same evaluator build and rules; the MCP server checks the build's hash against the chain before running it. Hidden-case scores still run a few points lower, because the practice cases are the ones you tuned on."],
];

export function HowItWorks() {
  return (
    <div className="page">
      <PageHero
        eyebrow="How it works"
        title={<>Sealed, scored, <span className="serif">settled</span>.</>}
        lede="Bakeoff combines a NEAR contract, an OutLayer trusted execution environment and NEAR AI Cloud so that builders never see the test cases, and every result names the exact rules, solution and cases it used."
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
          <p className="muted small flow-note">Measured on testnet and mainnet: 8–71 s from submission to recorded result. OutLayer compute cost 0.002–0.007 NEAR per run on testnet.</p>
        </section>

        <section className="guide-section">
          <Reveal className="guide-head"><span className="step-num mono">02</span><h2>What stays hidden, what is public</h2></Reveal>
          <div className="compare">
            <Reveal className="card card-pad compare-col">
              <h3><Lock /> Hidden</h3>
              <ul className="check-list">
                <li>The test cases and their labels, from builders and the public</li>
                <li>The owner's model API key</li>
                <li>Every per-ticket answer the models give</li>
              </ul>
            </Reveal>
            <Reveal delay={0.06} className="card card-pad compare-col">
              <h3><Hash /> Public</h3>
              <ul className="check-list">
                <li>The rules, requirements and the test set's hash</li>
                <li>The evaluator build and its hash</li>
                <li>Every solution config and its result</li>
                <li>Every reward, award and payout</li>
              </ul>
            </Reveal>
          </div>
          <Reveal className="card card-pad trust-card">
            <h3><Shield /> What you still have to trust</h3>
            <p className="text-2 trust-lead">A result can only come from the enclave: the contract accepts a verdict only as the callback of its own request to OutLayer. The one key that could change that is the challenge account's own, which could deploy different code. Opening a challenge deletes it, so from then on no key, Bakeoff's or the owner's, can write a result; each challenge page shows whether its account is locked. That leaves four things to trust:</p>
            <ul className="trust-list">
              <li><strong>The owner's test cases.</strong> The owner writes and labels them and sets the requirements. The evaluator scores a poor test as faithfully as a good one, so a pass is only as meaningful as the cases.</li>
              <li><strong>The enclave.</strong> The cases and API key stay hidden because OutLayer's TEE hardware and attestation hold. The contract checks every hash, but it cannot see inside the enclave.</li>
              <li><strong>The model provider.</strong> NEAR AI Cloud processes each hidden case to answer it. What the provider can see depends on the model; check its listing on NEAR AI Cloud.</li>
              <li><strong>This board's listings.</strong> Titles, descriptions and baselines come from the owner's published listing. Rewards, results and payments are read from the contract.</li>
            </ul>
          </Reveal>
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
