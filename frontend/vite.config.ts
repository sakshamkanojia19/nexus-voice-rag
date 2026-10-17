import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

/**
 * ONNX Runtime loads its Emscripten runtime with a dynamic import. During
 * dependency optimisation Vite rewrites that URL to `*.mjs?import`, then
 * rejects it because files in `public/` are deliberately not transformed.
 * Strip only that synthetic query flag so Vite's public-file middleware can
 * serve the runtime module unchanged, as ONNX expects.
 */
function serveVadRuntimeModules(): Plugin {
  return {
    name: "serve-vad-runtime-modules",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url) {
          const url = new URL(req.url, "http://vite.local");
          if (url.pathname.startsWith("/vad/") && url.pathname.endsWith(".mjs") && url.searchParams.has("import")) {
            url.searchParams.delete("import");
            req.url = `${url.pathname}${url.search}`;
          }
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [serveVadRuntimeModules(), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
