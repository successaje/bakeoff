import { animate, motion, useInView as useMotionInView } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { acceptingSubmissions, type ChallengeView, type Network, NETWORKS, nsToDate } from "../lib/near.ts";
import { usePrefersReducedMotion, useNow } from "../lib/hooks.ts";
import { Check, Copy, External } from "./Icons.tsx";

/** Fades and lifts its children in the first time they scroll into view. */
export function Reveal({ children, delay = 0, y = 10, className, as = "div", immediate = false }: { children: ReactNode; delay?: number; y?: number; className?: string; as?: "div" | "section" | "li"; immediate?: boolean }) {
  const reduced = usePrefersReducedMotion();
  const Tag = motion[as];
  // Page headers animate on arrival; everything else as it scrolls into view.
  const show = immediate ? { animate: { opacity: 1, y: 0 } } : { whileInView: { opacity: 1, y: 0 }, viewport: { once: true, margin: "-8% 0px" } };
  return (
    <Tag
      className={className}
      initial={reduced ? false : { opacity: 0, y }}
      {...show}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </Tag>
  );
}

/**
 * A number that counts up from zero when it first appears. The final value is
 * the element's text throughout, so screen readers, copied text and agents
 * reading the page get the real number; the count is drawn over it in CSS.
 */
export function CountUp({ value, decimals = 0, prefix = "", suffix = "" }: { value: number; decimals?: number; prefix?: string; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useMotionInView(ref, { once: true });
  const reduced = usePrefersReducedMotion();
  // The value drawn over the real one while counting; null once it is done.
  const [shown, setShown] = useState<number | null>(reduced ? null : 0);
  useEffect(() => {
    if (!seen || reduced) {
      if (reduced) setShown(null);
      return;
    }
    const controls = animate(0, value, { duration: 1.1, ease: [0.22, 1, 0.36, 1], onUpdate: setShown, onComplete: () => setShown(null) });
    return () => controls.stop();
  }, [seen, value, reduced]);
  const format = (n: number) => `${prefix}${n.toFixed(decimals)}${suffix}`;
  return <span ref={ref} className="count-up tabular" data-count={shown === null ? undefined : format(shown)}>{format(value)}</span>;
}

export type DisplayStatus = "draft" | "open" | "closing" | "awarded" | "closed";

export function displayStatus(view: ChallengeView, now = Date.now()): DisplayStatus {
  if (view.status === "Awarded") return "awarded";
  if (view.status === "Closed") return "closed";
  if (view.status === "Draft") return "draft";
  return acceptingSubmissions(view, now) ? "open" : "closing";
}

const STATUS: Record<DisplayStatus, { label: string; tone: string; live?: boolean }> = {
  draft: { label: "Draft", tone: "" },
  open: { label: "Open", tone: "badge-green", live: true },
  closing: { label: "Deadline passed", tone: "badge-amber" },
  awarded: { label: "Awarded", tone: "badge-sky" },
  closed: { label: "Closed", tone: "" },
};

export function StatusBadge({ view }: { view: ChallengeView }) {
  const now = useNow(30_000);
  const status = STATUS[displayStatus(view, now)];
  return <span className={`badge badge-dot ${status.tone} ${status.live ? "badge-live" : ""}`}>{status.label}</span>;
}

function parts(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
}

/** "2d 14h 03m 22s" to a deadline, ticking every second. */
export function Countdown({ closesAt }: { closesAt: string | null | undefined }) {
  const now = useNow(1000);
  const date = nsToDate(closesAt);
  if (!date) return <span className="muted">Set when it opens</span>;
  const left = date.getTime() - now;
  if (left <= 0) return <span className="muted">Closed {date.toISOString().slice(0, 10)}</span>;
  const { d, h, m, s } = parts(left);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <span className="countdown tabular">
      {d > 0 && <><b>{d}</b><i>d</i></>}<b>{pad(h)}</b><i>h</i><b>{pad(m)}</b><i>m</i><b>{pad(s)}</b><i>s</i>
    </span>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn copy"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          // Clipboard access can be refused; the text stays selectable.
        }
      }}
    >
      {copied ? <Check /> : <Copy />}
    </button>
  );
}

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <pre className="code" aria-label={label}>
      {code}
      <CopyButton text={code} label="Copy command" />
    </pre>
  );
}

export function explorer(network: Network, kind: "address" | "txns", id: string): string {
  return `${NETWORKS[network].explorer}/${kind}/${id}`;
}

/** An account name linked to the explorer. */
export function Account({ id, network, className = "" }: { id: string; network: Network; className?: string }) {
  return (
    <a className={`account-link ${className}`} href={explorer(network, "address", id)} target="_blank" rel="noopener noreferrer">
      <span className="break">{id}</span>
      <External aria-hidden="true" />
    </a>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === value}
          className={`tab ${tab.id === value ? "active" : ""}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.id === value && <motion.span layoutId="tab-indicator" className="tab-indicator" transition={{ type: "spring", bounce: 0.18, duration: 0.5 }} />}
          <span className="tab-label">{tab.label}</span>
          {tab.count !== undefined && <span className="tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Runs an action, showing progress and the outcome beside the button. */
export function ActionButton({ label, run, primary = false, disabled = false }: { label: ReactNode; run: () => Promise<string | void>; primary?: boolean; disabled?: boolean }) {
  const [state, setState] = useState<{ busy: boolean; ok?: string; error?: string }>({ busy: false });
  return (
    <div className="action">
      <button
        type="button"
        className={`btn ${primary ? "btn-primary" : ""}`}
        disabled={disabled || state.busy}
        onClick={async () => {
          setState({ busy: true });
          try {
            setState({ busy: false, ok: (await run()) ?? "Done." });
          } catch (error) {
            setState({ busy: false, error: (error as Error).message });
          }
        }}
      >
        {state.busy && <span className="spinner" aria-hidden="true" />}
        {label}
      </button>
      {state.ok && <span className="outcome ok"><Check /> {state.ok}</span>}
      {state.error && <span className="outcome error">{state.error}</span>}
    </div>
  );
}

/** Marks a demonstration round wherever its result appears. */
export function DemoBadge() {
  return <span className="badge badge-amber" title="A demonstration round run by the Bakeoff team">Demo</span>;
}

/** What a demonstration round is, and which parts of it are real. */
export function DemoNotice({ sponsor, network }: { sponsor: string; network: Network }) {
  return (
    <p className="notice demo-notice">
      <strong>Demonstration round.</strong> {sponsor} is a fictional store, and the Bakeoff team runs both its account and the competing ones.
      The contract, the scoring on hidden cases and the payment are real{network === "testnet" ? ", in testnet NEAR" : ", on NEAR mainnet"}.
    </p>
  );
}
