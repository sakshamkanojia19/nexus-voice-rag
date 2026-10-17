import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { LandingPage } from "@/components/landing/LandingPage";
import { RagApp } from "@/components/rag/RagApp";
import { useAuth } from "@/hooks/useAuth";

/**
 * "/" is the marketing front door for visitors; anyone already signed in goes
 * straight to the app — the ChatGPT pattern. Everything else is the app, which
 * maps its internal views onto /chat, /documents, /projects, /voice-agents.
 */
function Root() {
  const auth = useAuth();
  // Hold a blank charcoal frame until the session lookup resolves — rendering
  // the landing first would flash it at every signed-in user on every load.
  if (!auth.ready) return <div style={{ minHeight: "100vh", background: "#151317" }} />;
  return auth.user ? <Navigate to="/chat" replace /> : <LandingPage />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Root />} />
        <Route path="*" element={<RagApp />} />
      </Routes>
    </BrowserRouter>
  );
}
