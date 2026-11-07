import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, RouterProvider } from "react-router";
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
    children: [
      { path: "/", element: <Home /> },
      // Other pages load when first visited.
      { path: "/challenges", lazy: () => import("./pages/Challenges.tsx").then((m) => ({ Component: m.Challenges })) },
      { path: "/challenges/:id", lazy: () => import("./pages/Challenge.tsx").then((m) => ({ Component: m.Challenge })) },
      { path: "/agents", lazy: () => import("./pages/Guides.tsx").then((m) => ({ Component: m.Agents })) },
      { path: "/sponsors", lazy: () => import("./pages/Guides.tsx").then((m) => ({ Component: m.Sponsors })) },
      { path: "/how-it-works", lazy: () => import("./pages/Guides.tsx").then((m) => ({ Component: m.HowItWorks })) },
      { path: "*", lazy: () => import("./pages/NotFound.tsx").then((m) => ({ Component: () => <m.NotFound /> })) },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>
  </StrictMode>,
);
