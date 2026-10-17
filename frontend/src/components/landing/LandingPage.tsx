import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Cpu, FileText, Github, Hand, KeyRound, Mic } from "lucide-react";
import { NexusLogo, NexusMark } from "@/components/brand/NexusLogo";
import { config } from "@/lib/config";
import { ProductDemo } from "./ProductDemo";
import "./landing.css";

/**
 * The marketing front door, served at "/" for signed-out visitors — the same
 * single-page app as the chat, just a different route. Every CTA navigates to
 * /chat, where the access gate takes over: sign in → add your key → talk.
 *
 * The showcase is the real UI (see ProductDemo), and every number on this page
 * is one measured on the project's own hardware — the README's engineering log
 * has the source of each.
 */

const STACK = ["Silero VAD", "faster-whisper", "CTranslate2", "ONNX Runtime", "LangChain", "Qdrant", "FastAPI", "React"];

const PIPELINE = [
  { n: "01", title: "Hears you", tech: "Silero VAD, in the browser", metric: "32 ms frames" },
  { n: "02", title: "Waits for the end", tech: "Grammar + pitch endpointing", metric: "700–4000 ms hold" },
  { n: "03", title: "Transcribes", tech: "faster-whisper on your GPU", metric: "~3× realtime" },
  { n: "04", title: "Researches", tech: "Agent over your docs + the web", metric: "every claim cited" },
  { n: "05", title: "Answers", tech: "Streams sentence by sentence", metric: "interrupt any time" },
];

/** CPU decode time for a 4.7 s clip, 8 cores, int8 — README engineering log #3. */
const WHISPER_CPU = [
  { model: "base", s: 3.1 },
  { model: "small", s: 9.1 },
  { model: "large-v3-turbo", s: 18.2 },
  { model: "distil-large-v3", s: 21.3 },
];
const CLIP_SECONDS = 4.7;
const WHISPER_MAX = 22;

/**
 * Scroll effects, all decorative:
 * - Bidirectional reveals: .lp-reveal gets .lp-in toggled on EVERY viewport
 *   crossing, so sections replay their entrance when you scroll back up.
 * - Parallax: elements tagged data-lp-speed drift relative to the viewport
 *   centre (positive = background, lags behind; negative = foreground,
 *   floats ahead). Layout positions are measured with transforms cleared so
 *   the applied translate can't feed back into the next measurement.
 * - CSS-side layers (hero grid, ambient glow) read --lps (scrollY in px);
 *   the progress bar reads --lpp (0..1).
 * Reduced-motion users get a static page; phones skip the parallax math.
 */
function useScrollFx() {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const narrow = window.matchMedia("(max-width: 820px)");
    const effectsOn = () => !reduce.matches && !narrow.matches;

    const revealEls = Array.from(root.querySelectorAll<HTMLElement>(".lp-reveal"));
    let io: IntersectionObserver | null = null;
    if (reduce.matches || !("IntersectionObserver" in window)) {
      revealEls.forEach((el) => el.classList.add("lp-in"));
    } else {
      io = new IntersectionObserver(
        (entries) => entries.forEach((e) => e.target.classList.toggle("lp-in", e.isIntersecting)),
        { threshold: 0.12, rootMargin: "0px 0px -4% 0px" },
      );
      revealEls.forEach((el) => io!.observe(el));
    }

    type Layer = { el: HTMLElement; speed: number; top: number; height: number };
    const layers: Layer[] = Array.from(root.querySelectorAll<HTMLElement>("[data-lp-speed]")).map((el) => ({
      el,
      speed: parseFloat(el.dataset.lpSpeed ?? "0") || 0,
      top: 0,
      height: 0,
    }));

    const measure = () => {
      for (const l of layers) {
        l.el.style.transform = "";
        const r = l.el.getBoundingClientRect();
        l.top = r.top + window.scrollY;
        l.height = r.height;
      }
    };

    let raf = 0;
    const apply = () => {
      raf = 0;
      const y = window.scrollY;
      const vh = window.innerHeight;
      const max = document.documentElement.scrollHeight - vh;
      root.style.setProperty("--lpp", max > 0 ? Math.min(1, y / max).toFixed(4) : "0");
      if (!effectsOn()) return;
      root.style.setProperty("--lps", y.toFixed(0));
      for (const l of layers) {
        const delta = (l.top + l.height / 2 - y - vh / 2) * l.speed;
        l.el.style.transform = `translate3d(0, ${delta.toFixed(1)}px, 0)`;
      }
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const onResize = () => {
      if (effectsOn()) measure();
      onScroll();
    };
    const onMediaChange = () => {
      if (!effectsOn()) {
        layers.forEach((l) => (l.el.style.transform = ""));
        root.style.removeProperty("--lps");
      } else {
        measure();
      }
      onScroll();
    };

    if (effectsOn()) measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    reduce.addEventListener("change", onMediaChange);
    narrow.addEventListener("change", onMediaChange);
    apply();

    return () => {
      io?.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      reduce.removeEventListener("change", onMediaChange);
      narrow.removeEventListener("change", onMediaChange);
      if (raf) cancelAnimationFrame(raf);
      layers.forEach((l) => (l.el.style.transform = ""));
      root.style.removeProperty("--lps");
      root.style.removeProperty("--lpp");
    };
  }, []);
  return rootRef;
}

export function LandingPage() {
  const navigate = useNavigate();
  const enterApp = () => navigate("/chat");
  const rootRef = useScrollFx();
  const repo = config.repoUrl;

  return (
    <div className="landing" ref={rootRef}>
      <span className="lp-progress" aria-hidden />
      <div className="lp-nav-bar">
        <div className="lp-wrap">
          <nav>
            <button className="lp-wordmark" onClick={() => window.scrollTo({ top: 0 })} aria-label="Nexus — back to top">
              <NexusLogo className="lp-mark" />
              <span className="lp-wordmark-text">nex<em>us</em></span>
            </button>
            <div className="lp-nav-links">
              <a className="lp-hash" href="#product">Product</a>
              <a className="lp-hash" href="#how">How it works</a>
              <a className="lp-hash" href="#engineering">Engineering</a>
              <a className="lp-hash" href="#oss">Open source</a>
            </div>
            <div className="lp-nav-actions">
              <a className="lp-icon-btn" href={repo} target="_blank" rel="noopener noreferrer" aria-label="Nexus on GitHub">
                <Github size={18} />
              </a>
              <button className="lp-nav-login" onClick={enterApp}>Log in</button>
              <button className="lp-btn lp-btn-primary" onClick={enterApp}>Try it free</button>
            </div>
          </nav>
        </div>
      </div>

      <div className="lp-wrap">
        {/* ── Hero ── */}
        <header className="lp-hero">
          <span className="lp-float lp-float-a" data-lp-speed="0.14" aria-hidden />
          <span className="lp-float lp-float-b" data-lp-speed="-0.1" aria-hidden />
          <a className="lp-chip lp-rise" href={repo} target="_blank" rel="noopener noreferrer">
            <i aria-hidden />Open source · MIT licensed<ArrowRight size={13} aria-hidden />
          </a>
          <h1 className="lp-rise" style={{ animationDelay: "90ms" }}>Talk to your <em className="lp-accent">research</em></h1>
          <p className="lp-sub lp-rise" style={{ animationDelay: "180ms" }}>
            A voice research assistant that <b>waits while you think</b>, stops the moment you
            interrupt, and cites every answer from your documents and the live web. The whole
            voice stack runs free on your own machine.
          </p>
          <div className="lp-cta-row lp-rise" style={{ animationDelay: "270ms" }}>
            <button className="lp-btn lp-btn-primary" onClick={enterApp}>Try it free <ArrowRight size={15} aria-hidden /></button>
            <a className="lp-btn lp-btn-ghost" href={repo} target="_blank" rel="noopener noreferrer">
              <Github size={16} aria-hidden /> Star on GitHub
            </a>
          </div>
          <p className="lp-hero-note lp-rise" style={{ animationDelay: "360ms" }}>
            Bring your own OpenAI, Grok or Groq key · nothing to install
          </p>
        </header>

        {/* ── The product, playing itself ── */}
        <section id="product" className="lp-showcase lp-reveal lp-reveal-scale" aria-label="Product demo">
          <ProductDemo />
        </section>

        <div className="lp-stats lp-reveal" role="list">
          <div className="lp-stat" role="listitem"><b>700 ms</b><span>to know you've finished</span></div>
          <div className="lp-stat" role="listitem"><b>$0</b><span>per voice minute, self-hosted</span></div>
          <div className="lp-stat" role="listitem"><b>17</b><span>languages, 7 of them Indian</span></div>
          <div className="lp-stat" role="listitem"><b>MIT</b><span>open source</span></div>
        </div>

        {/* ── How a voice turn works ── */}
        <section id="how" className="lp-section" aria-label="How it works">
          <div className="lp-section-head lp-reveal">
            <p className="lp-eyebrow">How it works</p>
            <h2>Five stages, <em className="lp-accent">running at once</em></h2>
            <p>Whisper decodes while the endpointer waits out your pause. Speech starts on sentence one while sentence two is still streaming. A spoken “one sec” covers the web search.</p>
          </div>
          <ol className="lp-pipeline">
            {PIPELINE.map((s) => (
              <li key={s.n} className="lp-pipe lp-reveal">
                <span className="lp-pipe-n">{s.n}</span>
                <h3>{s.title}</h3>
                <p>{s.tech}</p>
                <span className="lp-pipe-metric">{s.metric}</span>
              </li>
            ))}
          </ol>
        </section>

        {/* ── Why Nexus: bento grid ── */}
        <section id="why" className="lp-section lp-has-float" aria-label="Why Nexus">
          <span className="lp-float lp-float-c" data-lp-speed="0.12" aria-hidden />
          <div className="lp-section-head lp-reveal">
            <p className="lp-eyebrow">Why Nexus</p>
            <h2>Built the <em className="lp-accent">other way</em> around</h2>
            <p>Most voice AI cuts you off on a silence timer, talks over you, and bills someone by the minute. Every one of those defaults is inverted here.</p>
          </div>

          <div className="lp-bento">
            <div className="lp-card lp-c7 lp-reveal">
              <div className="lp-icon" aria-hidden><Mic size={19} /></div>
              <h3>Knows when you're done talking</h3>
              <p>Turn-end is judged from the <b>words and the pitch contour</b> — dangling conjunctions, fillers, Hindi's verb-final grammar — not a silence timer that cuts you off mid-thought.</p>
              <div className="lp-utter" aria-label="Example of content-aware endpointing">
                <div className="lp-u-line lp-u-hold"><span>“what's the capital of…”</span><span className="lp-u-tag">holds the mic</span></div>
                <div className="lp-u-line lp-u-go"><span>“…of France?”</span><span className="lp-u-tag">replies after 700 ms</span></div>
              </div>
            </div>

            <div className="lp-card lp-c5 lp-reveal">
              <div className="lp-icon" aria-hidden><Hand size={19} /></div>
              <h3>Interrupt it any time</h3>
              <p>Barge-in with <b>six stacked defences</b> — it pauses the moment you speak, confirms it really heard you, then resumes on the exact word or commits. It never hears itself and loops.</p>
              <div className="lp-defence-row" aria-hidden>
                <span>pause</span><span>confirm</span><span>resume</span><span>commit</span>
              </div>
            </div>

            <div className="lp-card lp-c4 lp-reveal">
              <div className="lp-icon" aria-hidden><Cpu size={19} /></div>
              <h3>Speech-to-text on your GPU</h3>
              <p>faster-whisper runs on your own machine at <b>~3× realtime</b> on a 4 GB laptop GPU, decoding while you pause. No per-minute meter.</p>
            </div>

            <div className="lp-card lp-c4 lp-reveal">
              <div className="lp-icon" aria-hidden><FileText size={19} /></div>
              <h3>Grounded, cited answers</h3>
              <p>Your documents plus the live web. <b>Every claim carries a [n]</b> you can click through to the page it came from.</p>
            </div>

            <div className="lp-card lp-c4 lp-reveal">
              <div className="lp-icon" aria-hidden><KeyRound size={19} /></div>
              <h3>Your key, your bill</h3>
              <p>Bring an <b>OpenAI, Grok or Groq</b> key. It's never stored or logged, and it only ever goes to its own provider.</p>
            </div>
          </div>
        </section>

        {/* ── Engineering: the work behind it, and who did it ── */}
        <section id="engineering" className="lp-section" aria-label="Engineering">
          <div className="lp-section-head lp-reveal">
            <p className="lp-eyebrow">Engineering</p>
            <h2>The hard problems, <em className="lp-accent">measured</em> and solved</h2>
            <p>Real failures captured from live sessions — what was measured, and what changed because of it.</p>
          </div>

          <div className="lp-eng">
            <article className="lp-eng-card lp-eng-wide lp-reveal">
              <p className="lp-eng-kicker">Speech-to-text</p>
              <h3>CPU Whisper is a trap</h3>
              <p>Bigger Whisper models are more accurate, so the instinct is to take the biggest. On CPU, only <b>base</b> finishes before the speech it's transcribing does — so Nexus picks the model from the device and falls back down a ladder instead of failing.</p>
              <div className="lp-bars" role="img" aria-label="Seconds to transcribe a 4.7 second clip on CPU: base 3.1, small 9.1, large-v3-turbo 18.2, distil-large-v3 21.3">
                {WHISPER_CPU.map((w) => (
                  <div key={w.model} className="lp-bar-row">
                    <span className="lp-bar-label">{w.model}</span>
                    <span className="lp-bar-track">
                      <span className={w.s <= CLIP_SECONDS ? "lp-bar lp-bar-ok" : "lp-bar"} style={{ width: `${(w.s / WHISPER_MAX) * 100}%` }} />
                    </span>
                    <span className="lp-bar-value">{w.s.toFixed(1)}s</span>
                  </div>
                ))}
                <span className="lp-bar-marker" style={{ left: `calc(var(--lp-bar-label-w) + (100% - var(--lp-bar-label-w) - var(--lp-bar-value-w)) * ${CLIP_SECONDS / WHISPER_MAX})` }}>
                  <span>{CLIP_SECONDS}s of speech</span>
                </span>
              </div>
            </article>

            <article className="lp-eng-card lp-reveal">
              <p className="lp-eng-kicker">Web search</p>
              <h3>A scraper that returned skincare</h3>
              <p>Blocked scrapers still answer HTTP 200. “Elon Musk total revenue 2026” came back as snail-mucin listings. Every scraped result now passes a relevance gate tuned on real data: off-topic scored <b>0.0</b>, genuine <b>0.25</b>, cutoff <b>0.2</b>.</p>
            </article>

            <article className="lp-eng-card lp-reveal">
              <p className="lp-eng-kicker">Transcription</p>
              <h3>Whisper heard “RAG” as “drag”</h3>
              <p>It guesses toward common English. Nexus primes it with the conversation's own vocabulary, so it leans toward the words you're actually using.</p>
            </article>

            <article className="lp-eng-card lp-reveal">
              <p className="lp-eng-kicker">Barge-in</p>
              <h3>An interruption mistaken for echo</h3>
              <p>A real interruption arrived silent during playback and was discarded as echo three times in a row. It's now transcribed, never assumed.</p>
            </article>

            <article className="lp-eng-card lp-reveal">
              <p className="lp-eng-kicker">Security</p>
              <h3>Keys that leak through errors</h3>
              <p>Providers quote rejected keys in their 401s. Every error is redacted, and each key only travels to its own provider — <b>34 tests</b> hold that in place.</p>
            </article>
          </div>

          <div className="lp-author lp-reveal">
            <span className="lp-author-avatar" aria-hidden>SK</span>
            <div className="lp-author-text">
              <b>Designed, built and debugged by Saksham Kanojia</b>
              <span>Every number on this page was measured on a laptop and a 4 GB GPU.</span>
            </div>
            <div className="lp-author-links">
              <a className="lp-btn lp-btn-ghost lp-btn-sm" href={`${repo}#-engineering-log`} target="_blank" rel="noopener noreferrer">Read the engineering log</a>
              <a className="lp-btn lp-btn-ghost lp-btn-sm" href={config.authorUrl} target="_blank" rel="noopener noreferrer"><Github size={15} aria-hidden /> Saksham on GitHub</a>
            </div>
          </div>
        </section>

        {/* ── Open source ── */}
        <section className="lp-oss lp-reveal lp-has-float" id="oss" aria-label="Open source">
          <span className="lp-float lp-float-d" data-lp-speed="-0.08" aria-hidden />
          <p className="lp-eyebrow">Open source</p>
          <h2>MIT licensed. <em className="lp-accent">Fork it, ship it.</em></h2>
          <div className="lp-no-list">
            <span>No voice cloud</span>
            <span>No per-minute meter</span>
            <span>No lock-in</span>
          </div>
          <p>
            Every step of hearing you — detecting speech, knowing when you've finished, transcribing,
            speaking back — runs on <b>open models in your browser and on your own machine</b>. The
            only metered part is the language model, and that runs on <b>your own key</b>.
          </p>
          <div className="lp-providers" aria-label="Supported language model providers">
            <span>OpenAI</span><span>xAI Grok</span><span>Groq</span>
          </div>
          <div className="lp-marquee" aria-label="Open-source foundations">
            <div className="lp-marquee-track">
              {STACK.map((s) => <span key={s}>{s}</span>)}
              {STACK.map((s) => <span key={`${s}-dup`} className="lp-dup" aria-hidden>{s}</span>)}
            </div>
          </div>
          <div className="lp-cta-row">
            <a className="lp-btn lp-btn-ghost" href={repo} target="_blank" rel="noopener noreferrer">
              <Github size={16} aria-hidden /> View the source
            </a>
          </div>
        </section>

        {/* ── Closing ── */}
        <section className="lp-closing lp-reveal" id="start" aria-label="Get started">
          <div className="lp-closing-card">
            <NexusMark className="lp-closing-mark" />
            <h2>Your research is waiting <em className="lp-accent">to talk</em>.</h2>
            <p>Ask your first question out loud in the next two minutes.</p>
            <div className="lp-cta-row">
              <button className="lp-btn lp-btn-primary" onClick={enterApp}>Try it free <ArrowRight size={15} aria-hidden /></button>
              <button className="lp-btn lp-btn-ghost" onClick={enterApp}>Log in</button>
            </div>
            <div className="lp-mini-steps">
              <span><b>1</b>Sign in with Google</span>
              <span><b>2</b>Add your API key</span>
              <span><b>3</b>Start talking</span>
            </div>
          </div>
        </section>
      </div>

      <footer>
        <div className="lp-wrap">
          <div className="lp-foot-grid">
            <div className="lp-foot-brand">
              <button className="lp-wordmark" onClick={() => window.scrollTo({ top: 0 })} aria-label="Nexus — back to top">
                <NexusLogo className="lp-mark lp-mark-sm" />
                <span className="lp-wordmark-text">nex<em>us</em></span>
              </button>
              <p>The open-source voice research assistant that knows when you're done talking.</p>
            </div>
            <div className="lp-foot-cols">
              <div className="lp-foot-col">
                <b>Product</b>
                <a href="#product">Demo</a>
                <a href="#how">How it works</a>
                <button onClick={enterApp}>Log in</button>
              </div>
              <div className="lp-foot-col">
                <b>Open source</b>
                <a href={repo} target="_blank" rel="noopener noreferrer">GitHub</a>
                <a href={`${repo}#-engineering-log`} target="_blank" rel="noopener noreferrer">Engineering log</a>
                <a href={`${repo}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">MIT license</a>
              </div>
              <div className="lp-foot-col">
                <b>Author</b>
                <a href={config.authorUrl} target="_blank" rel="noopener noreferrer">Saksham Kanojia</a>
              </div>
            </div>
          </div>
          <div className="lp-foot-bottom">
            <span>© 2026 Nexus · MIT licensed</span>
            <span className="lp-foot-made">
              Made with <span className="lp-heart" aria-hidden>♥</span>
              <span className="sr-only">love</span> by <b>Saksham Kanojia</b>
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
