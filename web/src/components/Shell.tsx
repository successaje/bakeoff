/** Header, footer and the page frame around every route. */

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useOutlet } from "react-router";
import { useSession } from "../lib/session.tsx";
import { applyTheme, storedTheme, type ThemeChoice } from "../lib/theme.ts";
import type { Network } from "../lib/near.ts";
import { usePrefersReducedMotion } from "../lib/hooks.ts";
import { Chevron, Close, Copy, External, Github, LogoMark, LogOut, Menu, Monitor, Moon, Sun, Wallet } from "./Icons.tsx";
import { explorer } from "./ui.tsx";

const REPO = "https://github.com/successaje/bakeoff";

const NAV = [
  { to: "/challenges", label: "Challenges" },
  { to: "/how-it-works", label: "How it works" },
  { to: "/builders", label: "For builders" },
  { to: "/teams", label: "For teams" },
];

function Brand() {
  return (
    <Link to="/" className="brand" aria-label="Bakeoff home">
      <LogoMark />
      <span>Bakeoff</span>
    </Link>
  );
}

function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(storedTheme);
  const next: Record<ThemeChoice, ThemeChoice> = { system: "light", light: "dark", dark: "system" };
  const label = { system: "Theme: system", light: "Theme: light", dark: "Theme: dark" }[choice];
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={`${label}. Change theme`}
      title={label}
      onClick={() => {
        const value = next[choice];
        setChoice(value);
        applyTheme(value, true);
      }}
    >
      {choice === "light" ? <Sun /> : choice === "dark" ? <Moon /> : <Monitor />}
    </button>
  );
}

function NetworkSwitch() {
  const { network, setNetwork } = useSession();
  return (
    <div className="segmented" role="radiogroup" aria-label="Network">
      {(["mainnet", "testnet"] as Network[]).map((n) => (
        <button key={n} type="button" role="radio" aria-checked={n === network} className={n === network ? "active" : ""} onClick={() => setNetwork(n)}>
          {n === network && <motion.span layoutId="network-pill" className="segmented-pill" transition={{ type: "spring", bounce: 0.2, duration: 0.45 }} />}
          <span>{n === "testnet" ? "Testnet" : "Mainnet"}</span>
        </button>
      ))}
    </div>
  );
}

function WalletButton() {
  const { account, signIn, signOut, network, walletReady } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => !ref.current?.contains(event.target as Node) && setOpen(false);
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  if (!account) {
    return (
      <button type="button" className="btn btn-primary btn-sm" disabled={!walletReady} onClick={() => void signIn()}>
        <Wallet /> <span>Connect</span>
      </button>
    );
  }
  return (
    <div className="menu" ref={ref}>
      <button type="button" className="btn btn-sm account-chip" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="avatar" aria-hidden="true">{account.slice(0, 1).toUpperCase()}</span>
        <span className="account-name">{account}</span>
        <Chevron />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div className="menu-panel" initial={{ opacity: 0, y: -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.98 }} transition={{ duration: 0.16 }}>
            <div className="menu-head">
              <span className="muted">Connected on {network}</span>
              <strong className="break">{account}</strong>
            </div>
            <button type="button" className="menu-item" onClick={() => { void navigator.clipboard?.writeText(account); setOpen(false); }}><Copy /> Copy account</button>
            <a className="menu-item" href={explorer(network, "address", account)} target="_blank" rel="noopener noreferrer"><External /> View on explorer</a>
            <button type="button" className="menu-item" onClick={() => { void signOut(); setOpen(false); }}><LogOut /> Disconnect</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [mobile, setMobile] = useState(false);
  const location = useLocation();
  useEffect(() => setMobile(false), [location.pathname]);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    document.body.style.overflow = mobile ? "hidden" : "";
  }, [mobile]);

  return (
    <header className={`site-header ${scrolled ? "scrolled" : ""}`}>
      <div className="container header-inner">
        <Brand />
        <nav className="nav" aria-label="Main">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>{item.label}</NavLink>
          ))}
        </nav>
        <div className="header-actions">
          <NetworkSwitch />
          <ThemeToggle />
          <WalletButton />
          <button type="button" className="icon-btn mobile-only" aria-label={mobile ? "Close menu" : "Open menu"} aria-expanded={mobile} onClick={() => setMobile((m) => !m)}>
            {mobile ? <Close /> : <Menu />}
          </button>
        </div>
      </div>
      <AnimatePresence>
        {mobile && (
          <motion.div className="mobile-sheet" initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }} transition={{ duration: 0.22 }}>
            <nav aria-label="Mobile">
              {NAV.map((item, i) => (
                <motion.div key={item.to} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.04 * i }}>
                  <NavLink to={item.to} className={({ isActive }) => `mobile-link ${isActive ? "active" : ""}`}>{item.label}</NavLink>
                </motion.div>
              ))}
            </nav>
            <div className="mobile-network"><span className="muted">Network</span><NetworkSwitch /></div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}

function Footer() {
  const { network } = useSession();
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="footer-top">
          <div className="footer-brand">
            <Brand />
            <p className="muted">Make your AI work better. Set a goal, compare solutions, reward results.</p>
          </div>
          <div className="footer-links">
            <div>
              <h4>Product</h4>
              <Link to="/challenges">Challenges</Link>
              <Link to="/how-it-works">How it works</Link>
            </div>
            <div>
              <h4>Build</h4>
              <Link to="/builders">For builders</Link>
              <Link to="/teams">For teams</Link>
              <a href={REPO} target="_blank" rel="noopener noreferrer">Source</a>
            </div>
            <div>
              <h4>Built on</h4>
              <a href="https://near.org" target="_blank" rel="noopener noreferrer">NEAR</a>
              <a href="https://outlayer.ai" target="_blank" rel="noopener noreferrer">OutLayer</a>
              <a href="https://near.ai" target="_blank" rel="noopener noreferrer">NEAR AI Cloud</a>
            </div>
          </div>
        </div>
        <div className="footer-bottom">
          <span className="footer-status"><span className="status-dot" aria-hidden="true" /> Reading {network} live</span>
          <span className="muted">Bounties, results and payments are read from NEAR. Titles, descriptions and baselines are published by each challenge's owner.</span>
          <a href={REPO} target="_blank" rel="noopener noreferrer" className="icon-btn" aria-label="Source on GitHub"><Github /></a>
        </div>
      </div>
    </footer>
  );
}

export function Shell() {
  const location = useLocation();
  const outlet = useOutlet();
  const reduced = usePrefersReducedMotion();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [location.pathname]);
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <Header />
      {/* Each page animates in on arrival. There is no exit animation to wait
          on, so a page that is still loading can never hold up the next one. */}
      <motion.main
        id="main"
        key={location.pathname}
        initial={reduced ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
      >
        {outlet}
      </motion.main>
      <Footer />
    </>
  );
}
