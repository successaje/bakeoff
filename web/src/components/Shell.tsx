/**
 * The frame around every page: a rail of destinations on the left, a bar
 * with search and the visitor's controls on top, and the footer. On narrow
 * screens the rail becomes a drawer.
 */

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate, useOutlet } from "react-router";
import { loadAll } from "../lib/data.ts";
import { usePrefersReducedMotion } from "../lib/hooks.ts";
import type { Network } from "../lib/near.ts";
import { loadRegistry } from "../lib/registry.ts";
import { accountItems, challengeItems, search, type SearchItem } from "../lib/search.ts";
import { useSession } from "../lib/session.tsx";
import { applyTheme, storedTheme, type ThemeChoice } from "../lib/theme.ts";
import { Avatar, HostMark } from "./art.tsx";
import { Building, Bot, Chevron, Close, Copy, External, Github, Home, LogoMark, LogOut, Menu, Monitor, Moon, Plus, Podium, Search, Shield, Sun, Trophy, Wallet } from "./Icons.tsx";
import { explorer } from "./ui.tsx";

const REPO = "https://github.com/successaje/bakeoff";

const NAV = [
  { to: "/", label: "Home", icon: Home, end: true },
  { to: "/challenges", label: "Challenges", icon: Trophy },
  { to: "/leaderboard", label: "Leaderboard", icon: Podium },
  { to: "/builders", label: "For builders", icon: Bot },
  { to: "/teams", label: "For teams", icon: Building },
  { to: "/how-it-works", label: "How it works", icon: Shield },
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
  const next: Record<ThemeChoice, ThemeChoice> = { light: "dark", dark: "system", system: "light" };
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

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => !ref.current?.contains(event.target as Node) && close();
    const escape = (event: KeyboardEvent) => event.key === "Escape" && close();
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, close]);
  return ref;
}

function WalletButton() {
  const { account, signIn, signOut, network, walletReady } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));

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
        <Avatar id={account} size={24} />
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
            <Link className="menu-item" to={`/accounts/${account}`} onClick={() => setOpen(false)}><Podium /> Your results</Link>
            <button type="button" className="menu-item" onClick={() => { void navigator.clipboard?.writeText(account); setOpen(false); }}><Copy /> Copy account</button>
            <a className="menu-item" href={explorer(network, "address", account)} target="_blank" rel="noopener noreferrer"><External /> View on explorer</a>
            <button type="button" className="menu-item" onClick={() => { void signOut(); setOpen(false); }}><LogOut /> Disconnect</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Challenges on both networks, and the builders on this one, found as you type. */
function SearchBox({ onDone }: { onDone?: () => void }) {
  const { network } = useSession();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [items, setItems] = useState<SearchItem[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const ref = useDismiss(open, () => setOpen(false));

  // The index loads the first time the box is used.
  const [wanted, setWanted] = useState(false);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void Promise.all([loadRegistry(), loadAll(network).catch(() => [])]).then(([registry, details]) => {
      if (!live) return;
      const accounts = details.flatMap((d) => d.evaluations.map((e) => e.submitter));
      setItems([...challengeItems(registry), ...accountItems(accounts, network)]);
    });
    return () => {
      live = false;
    };
  }, [wanted, network]);

  // "/" focuses the box from anywhere but a text field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(target.tagName) && !target.isContentEditable) {
        event.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const results = useMemo(() => search(items, query), [items, query]);
  const go = (item: SearchItem | undefined) => {
    if (!item) return;
    navigate(item.to);
    setQuery("");
    setOpen(false);
    input.current?.blur();
    onDone?.();
  };

  return (
    <div className="search" ref={ref} role="search">
      <Search className="search-icon" />
      <input
        ref={input}
        className="search-input"
        type="search"
        placeholder="Search challenges and builders"
        aria-label="Search challenges and builders"
        aria-expanded={open && query.trim() !== ""}
        aria-controls="search-results"
        aria-autocomplete="list"
        role="combobox"
        value={query}
        onFocus={() => {
          setWanted(true);
          setOpen(true);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
          if (event.key === "ArrowUp") { event.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (event.key === "Enter") { event.preventDefault(); go(results[active]); }
        }}
      />
      <kbd className="search-kbd" aria-hidden="true">/</kbd>
      <AnimatePresence>
        {open && query.trim() !== "" && (
          <motion.ul id="search-results" className="search-results" role="listbox" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.14 }}>
            {results.length === 0 ? (
              <li className="search-empty muted">No challenge or builder matches “{query.trim()}”.</li>
            ) : results.map((item, i) => (
              <li key={`${item.kind}:${item.to}`} role="option" aria-selected={i === active}>
                <button type="button" className={`search-item ${i === active ? "active" : ""}`} onMouseEnter={() => setActive(i)} onClick={() => go(item)}>
                  {item.kind === "challenge" ? <HostMark name={item.detail.split(" · ")[0]!} size={28} /> : <Avatar id={item.title} size={28} />}
                  <span className="search-item-text">
                    <strong>{item.title}</strong>
                    <span className="muted small">{item.detail}</span>
                  </span>
                </button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}

const RAIL_KEY = "bakeoff:rail";

function Rail({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <aside className="rail" aria-label="Main">
      <div className="rail-top">
        <button type="button" className="rail-toggle" aria-label={open ? "Collapse the menu" : "Expand the menu"} aria-expanded={open} onClick={onToggle}><Menu /></button>
        <Brand />
      </div>
      <Link to="/teams" className="rail-create" title="Host a challenge">
        <Plus /><span className="rail-label">Host a challenge</span>
      </Link>
      <nav className="rail-nav">
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `rail-link ${isActive ? "active" : ""}`} title={open ? undefined : item.label}>
            <item.icon />
            <span className="rail-label">{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="rail-bottom">
        <a className="rail-link" href={REPO} target="_blank" rel="noopener noreferrer" title={open ? undefined : "Source on GitHub"}>
          <Github />
          <span className="rail-label">Source</span>
        </a>
      </div>
    </aside>
  );
}

function TopBar({ onMenu, menuOpen }: { onMenu: () => void; menuOpen: boolean }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <header className={`topbar ${scrolled ? "scrolled" : ""}`}>
      <button type="button" className="icon-btn mobile-only" aria-label={menuOpen ? "Close menu" : "Open menu"} aria-expanded={menuOpen} onClick={onMenu}>
        {menuOpen ? <Close /> : <Menu />}
      </button>
      <span className="mobile-only topbar-brand"><Brand /></span>
      <SearchBox />
      <div className="topbar-actions">
        <NetworkSwitch />
        <ThemeToggle />
        <WalletButton />
      </div>
    </header>
  );
}

function Drawer({ onClose }: { onClose: () => void }) {
  return (
    <motion.div className="drawer-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.aside className="drawer" aria-label="Menu" initial={{ x: -24, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -24, opacity: 0 }} transition={{ duration: 0.22 }} onClick={(event) => event.stopPropagation()}>
        <div className="drawer-head"><Brand /><button type="button" className="icon-btn" aria-label="Close menu" onClick={onClose}><Close /></button></div>
        <div className="drawer-search"><SearchBox onDone={onClose} /></div>
        <Link to="/teams" className="btn btn-primary drawer-create" onClick={onClose}><Plus /> Host a challenge</Link>
        <nav className="drawer-nav">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `drawer-link ${isActive ? "active" : ""}`} onClick={onClose}>
              <item.icon /> {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="drawer-row"><span className="muted small">Network</span><NetworkSwitch /></div>
        <div className="drawer-row"><span className="muted small">Theme</span><ThemeToggle /></div>
      </motion.aside>
    </motion.div>
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
              <Link to="/leaderboard">Leaderboard</Link>
              <Link to="/how-it-works">How it works</Link>
            </div>
            <div>
              <h4>Build</h4>
              <Link to="/builders">For builders</Link>
              <Link to="/teams">Host a challenge</Link>
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
          <span className="muted">Rewards, results and payments are read from NEAR. Titles, descriptions and baselines are published by each challenge's owner.</span>
          <a href={REPO} target="_blank" rel="noopener noreferrer" className="icon-btn" aria-label="Source on GitHub"><Github /></a>
        </div>
      </div>
    </footer>
  );
}

function storedRail(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) !== "closed";
  } catch {
    return true;
  }
}

export function Shell() {
  const location = useLocation();
  const outlet = useOutlet();
  const reduced = usePrefersReducedMotion();
  const [railOpen, setRailOpen] = useState(storedRail);
  const [drawer, setDrawer] = useState(false);
  // A challenge's tabs share one page, so only a new page scrolls to the top.
  const page = location.pathname.split("/").slice(0, 3).join("/");
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    setDrawer(false);
  }, [page]);
  useEffect(() => {
    document.body.style.overflow = drawer ? "hidden" : "";
  }, [drawer]);
  const toggleRail = () => {
    setRailOpen((o) => {
      try {
        localStorage.setItem(RAIL_KEY, o ? "closed" : "open");
      } catch {
        // Applies for this visit only.
      }
      return !o;
    });
  };
  return (
    <div className={`app ${railOpen ? "rail-open" : "rail-closed"}`}>
      <a className="skip-link" href="#main">Skip to content</a>
      <Rail open={railOpen} onToggle={toggleRail} />
      <div className="app-main">
        <TopBar onMenu={() => setDrawer((d) => !d)} menuOpen={drawer} />
        {/* Each page animates in on arrival. There is no exit animation to wait
            on, so a page that is still loading can never hold up the next one. */}
        <motion.main
          id="main"
          key={page}
          initial={reduced ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
        >
          {outlet}
        </motion.main>
        <Footer />
      </div>
      <AnimatePresence>{drawer && <Drawer onClose={() => setDrawer(false)} />}</AnimatePresence>
    </div>
  );
}
