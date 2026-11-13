import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Fonts are bundled (no network fetch).
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/figtree";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "../styles.css";
import PayApp from "./PayApp.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <StrictMode>
    <PayApp />
  </StrictMode>,
);
