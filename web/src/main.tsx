import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";
import "./styles/board.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, Navigate, RouterProvider } from "react-router";
import { ErrorBoundary, PageError } from "./components/ErrorBoundary.tsx";
import { Shell } from "./components/Shell.tsx";
import { SessionProvider } from "./lib/session.tsx";
import { applyTheme, storedTheme } from "./lib/theme.ts";
import { Home } from "./pages/Home.tsx";

applyTheme(storedTheme());

// Hash routes work from any static host or sub-path, GitHub Pages included.
const router = createHashRouter([
  {
    element: <Shell />,
    // Shown for the moment a directly opened page's code is still loading.
    HydrateFallback: () => null,
    // A page that fails shows its error inside the header and footer.
    children: [
      { path: "/", element: <Home />, ErrorBoundary: PageError },
      // Other pages load when first visited.
      { path: "/challenges", lazy: () => import("./pages/Challenges.tsx").then((m) => ({ Component: m.Challenges })), ErrorBoundary: PageError },
      { path: "/challenges/:id", lazy: () => import("./pages/Challenge.tsx").then((m) => ({ Component: m.Challenge })), ErrorBoundary: PageError },
      { path: "/challenges/:id/results/:n", lazy: () => import("./pages/Result.tsx").then((m) => ({ Component: m.Result })), ErrorBoundary: PageError },
      { path: "/challenges/:id/:tab", lazy: () => import("./pages/Challenge.tsx").then((m) => ({ Component: m.Challenge })), ErrorBoundary: PageError },
      { path: "/leaderboard", lazy: () => import("./pages/Leaderboard.tsx").then((m) => ({ Component: m.Leaderboard })), ErrorBoundary: PageError },
      { path: "/accounts/:id", lazy: () => import("./pages/Account.tsx").then((m) => ({ Component: m.Account })), ErrorBoundary: PageError },
      { path: "/builders", lazy: () => import("./pages/Guides.tsx").then((m) => ({ Component: m.Builders })), ErrorBoundary: PageError },
      { path: "/teams", lazy: () => import("./pages/Guides.tsx").then((m) => ({ Component: m.Teams })), ErrorBoundary: PageError },
      // The guides' earlier addresses, kept for links already shared.
      { path: "/agents", element: <Navigate to="/builders" replace /> },
      { path: "/sponsors", element: <Navigate to="/teams" replace /> },
      { path: "/how-it-works", lazy: () => import("./pages/Guides.tsx").then((m) => ({ Component: m.HowItWorks })), ErrorBoundary: PageError },
      { path: "*", lazy: () => import("./pages/NotFound.tsx").then((m) => ({ Component: () => <m.NotFound /> })), ErrorBoundary: PageError },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    </ErrorBoundary>
  </StrictMode>,
);
