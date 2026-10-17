import { useEffect, useId, useRef, useState } from "react";
import { gsap } from "gsap";
import { AudioLines, BriefcaseBusiness, Check, FolderOpen, KeyRound, LogIn, LogOut, MoreHorizontal, PanelLeft, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { NexusLogo, NexusWordmark } from "@/components/brand/NexusLogo";
import type { UseAuthReturn } from "@/hooks/useAuth";
import { config } from "@/lib/config";
import { cn } from "@/lib/utils";
import type { ConversationMeta } from "@/hooks/useChat";

interface SidebarProps {
  onNewChat: () => void;
  onShowDocuments: () => void;
  onShowNProjects: () => void;
  onShowVoices: () => void;
  activePanel?: "documents" | "nprojects" | "voiceagents" | null;
  conversations: ConversationMeta[];
  activeId: string | null;
  onSelectConversation: (id: string) => void;
  onRenameConversation: (id: string, title: string) => void;
  onDeleteConversation: (id: string) => void;
  open: boolean; // mobile drawer
  onClose: () => void;
  auth?: UseAuthReturn;
  onSignIn?: () => void;
  /** Open the BYOK page. Omitted — and the row hidden — when this deployment
   *  doesn't accept user keys, or when nobody is signed in to attach one to. */
  onManageApiKey?: () => void;
  /** True when a key is currently saved in this browser. */
  hasApiKey?: boolean;
}

const COLLAPSE_KEY = "ucb_sidebar_collapsed";

/** Time bucket for the Recents list — the grouping every mature chat app uses,
 *  because "which conversation was it" is almost always answered by "when". */
const GROUP_ORDER = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"] as const;
type GroupLabel = (typeof GROUP_ORDER)[number];

function groupFor(updatedAt: number): GroupLabel {
  const startOfDay = (t: number): number => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.floor((startOfDay(Date.now()) - startOfDay(updatedAt)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return "Older";
}

export function Sidebar({
  onNewChat,
  onShowDocuments,
  onShowNProjects,
  onShowVoices,
  activePanel = null,
  conversations,
  activeId,
  onSelectConversation,
  onRenameConversation,
  onDeleteConversation,
  open,
  onClose,
  auth,
  onSignIn,
  onManageApiKey,
  hasApiKey,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    typeof window === "undefined" ? false : localStorage.getItem(COLLAPSE_KEY) === "1",
  );
  const [query, setQuery] = useState("");
  const asideRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  // 3D swing when toggling collapse (CiteTalk-style minimise).
  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const el = asideRef.current;
    if (!el) return;
    gsap.fromTo(
      el,
      { rotationY: collapsed ? 10 : -10, transformPerspective: 1100, transformOrigin: "left center" },
      { rotationY: 0, duration: 0.55, ease: "power3.out" },
    );
  }, [collapsed]);

  // Collapsing is a desktop affordance — on mobile the logo stays a plain mark.
  const toggleCollapsed = () => {
    if (typeof window !== "undefined" && !window.matchMedia("(min-width: 768px)").matches) return;
    setCollapsed((v) => !v);
  };

  // Collapse is a DESKTOP layout preference. The mobile drawer must never
  // inherit it: a persisted collapse produced an icon-only drawer with the
  // floating "+" fallback hovering over the page. While the drawer is open,
  // labels always show.
  const iconOnly = collapsed && !open;
  const showLabels = !iconOnly;

  return (
    <>
      {open ? (
        <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden" onClick={onClose} aria-hidden />
      ) : null}

      <aside
        ref={asideRef}
        className={cn(
          "z-50 flex h-full shrink-0 flex-col gap-3 border-r border-border bg-card p-3 transition-[width] duration-300 ease-out",
          "w-[280px]",
          collapsed ? "md:w-[74px]" : "md:w-[280px]",
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:shadow-2xl max-md:transition-transform",
          open ? "max-md:translate-x-0" : "max-md:-translate-x-full",
        )}
      >
        {/* Collapsed (desktop): the logo itself is the expander */}
        {collapsed ? (
          <div className="hidden justify-center md:flex">
            <SidebarToggle collapsed={collapsed} onToggle={toggleCollapsed} />
          </div>
        ) : null}

        {/* Expanded brand row (also used on mobile) */}
        <div className={cn("flex items-center justify-between", collapsed && "md:hidden")}>
          <NexusWordmark logo={<SidebarToggle collapsed={collapsed} onToggle={toggleCollapsed} />} />
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted md:hidden"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* Nav */}
        <nav className="mt-1 flex flex-col gap-1">
          <NavItem icon={<Plus className="size-[18px]" />} label="New chat" collapsed={iconOnly} active={activePanel === null} onClick={onNewChat} />
          <NavItem icon={<FolderOpen className="size-[18px]" />} label="Documents" collapsed={iconOnly} active={activePanel === "documents"} onClick={onShowDocuments} />
          <NavItem icon={<BriefcaseBusiness className="size-[18px]" />} label="N Projects" collapsed={iconOnly} active={activePanel === "nprojects"} onClick={onShowNProjects} />
          <NavItem icon={<AudioLines className="size-[18px]" />} label="Voice Agents" collapsed={iconOnly} active={activePanel === "voiceagents"} onClick={onShowVoices} />
        </nav>

        {/* Recents */}
        <div className="mt-1 flex min-h-0 flex-1 flex-col">
          {showLabels ? (
            <>
              {conversations.length > 3 ? (
                <div className="relative mb-2 px-0.5">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search chats"
                    aria-label="Search chats"
                    className="h-8 w-full rounded-lg border border-border/70 bg-background/60 pl-8 pr-7 text-xs text-foreground placeholder:text-muted-foreground/70 focus:border-primary/50 focus:outline-none"
                  />
                  {query ? (
                    <button
                      onClick={() => setQuery("")}
                      aria-label="Clear search"
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Recents
                </div>
              )}
              {(() => {
                const q = query.trim().toLowerCase();
                const shown = q
                  ? conversations.filter((c) => c.title.toLowerCase().includes(q))
                  : conversations;
                if (conversations.length === 0) {
                  return <p className="px-1 text-xs text-muted-foreground/60">No conversations yet.</p>;
                }
                if (shown.length === 0) {
                  return <p className="px-1 text-xs text-muted-foreground/60">No chats match “{query.trim()}”.</p>;
                }
                const groups = new Map<GroupLabel, ConversationMeta[]>();
                for (const c of shown) {
                  const g = groupFor(c.updatedAt);
                  groups.set(g, [...(groups.get(g) ?? []), c]);
                }
                return (
                  <div className="-mr-1 flex min-h-0 flex-1 flex-col overflow-y-auto pr-1">
                    {GROUP_ORDER.filter((g) => groups.has(g)).map((g) => (
                      <div key={g} className="mb-1.5">
                        <div className="px-1 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                          {g}
                        </div>
                        <div className="flex flex-col gap-0.5">
                          {(groups.get(g) ?? []).map((c) => (
                            <RecentRow
                              key={c.id}
                              conv={c}
                              active={c.id === activeId}
                              onSelect={() => onSelectConversation(c.id)}
                              onRename={(title) => onRenameConversation(c.id, title)}
                              onDelete={() => onDeleteConversation(c.id)}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </>
          ) : null}
        </div>

        {/* Footer */}
        {showLabels ? (
          <div className="border-t border-border/60 pt-2">
            {onManageApiKey ? (
              <button
                onClick={onManageApiKey}
                title={hasApiKey ? "A key is saved in this browser" : undefined}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <KeyRound className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-left">API key</span>
                {hasApiKey ? (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-success shadow-[0_0_6px_currentColor]"
                    aria-label="A key is saved in this browser"
                  />
                ) : null}
              </button>
            ) : null}
            {auth?.enabled ? <AccountRow auth={auth} onSignIn={onSignIn} /> : null}
            <div className="flex items-center gap-1.5 px-1 pt-1.5 text-[11px] text-muted-foreground">
              <span className="size-1.5 rounded-full bg-success shadow-[0_0_6px_currentColor]" />
              {config.botName} · grounded answers with sources
            </div>
            <div className="px-1 pb-0.5 pt-1 text-[11px] text-muted-foreground">
              Made with <span className="text-[hsl(305_88%_60%)]" aria-hidden>♥</span>
              <span className="sr-only">love</span> by{" "}
              <span className="font-medium text-foreground/80">Saksham Kanojia</span>
            </div>
          </div>
        ) : (
          <button
            onClick={onNewChat}
            title="New chat"
            aria-label="New chat"
            className="mx-auto mb-1 flex size-9 items-center justify-center rounded-xl bg-brand-gradient text-white shadow-glow"
          >
            <Plus className="size-5" />
          </button>
        )}
      </aside>
    </>
  );
}

/** Signed-in identity, or the prompt to sign in. Anonymous is a valid state —
 *  the app works fully without an account, so this never nags. */
function AccountRow({ auth, onSignIn }: { auth: UseAuthReturn; onSignIn?: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  if (!auth.ready) return <div className="h-10" />;

  if (!auth.user) {
    return (
      <button
        onClick={onSignIn}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        <LogIn className="size-[18px] shrink-0" />
        <span className="min-w-0 flex-1 truncate">Sign in</span>
      </button>
    );
  }

  const label = auth.user.name || auth.user.email || "Signed in";
  const initial = (label[0] ?? "?").toUpperCase();

  return (
    <div className="relative">
      <button
        onClick={() => setMenuOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/60"
      >
        {auth.user.avatarUrl ? (
          <img src={auth.user.avatarUrl} alt="" className="size-7 shrink-0 rounded-full object-cover" />
        ) : (
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand-gradient text-xs font-semibold text-white">
            {initial}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-foreground">{label}</span>
          {auth.user.name && auth.user.email ? (
            <span className="block truncate text-[11px] text-muted-foreground">{auth.user.email}</span>
          ) : null}
        </span>
      </button>

      {menuOpen ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} aria-hidden />
          <div className="surface absolute bottom-full left-1 z-50 mb-1 w-44 overflow-hidden rounded-lg border border-border shadow-soft">
            <button
              onClick={() => { setMenuOpen(false); void auth.signOut(); }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground hover:bg-muted"
            >
              <LogOut className="size-3.5" /> Sign out
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The Nexus logo doubles as the sidebar expander/collapser: hovering morphs the
 * mark into a panel icon, and toggling flips the tile over on its Y axis so the
 * two states feel connected rather than swapped.
 */
function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const el = ref.current;
    if (!el) return;
    gsap.fromTo(
      el,
      { rotationY: collapsed ? -180 : 180, scale: 0.7, transformPerspective: 620 },
      { rotationY: 0, scale: 1, duration: 0.6, ease: "back.out(1.6)" },
    );
  }, [collapsed]);

  return (
    <button
      ref={ref}
      onClick={onToggle}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-expanded={!collapsed}
      className="group/toggle relative size-9 shrink-0 rounded-xl outline-none ring-offset-2 ring-offset-card focus-visible:ring-2 focus-visible:ring-ring"
    >
      <NexusLogo className="size-9 rounded-xl shadow-glow transition-all duration-200 ease-out group-hover/toggle:scale-90 group-hover/toggle:opacity-0 group-focus-visible/toggle:scale-90 group-focus-visible/toggle:opacity-0 max-md:!scale-100 max-md:!opacity-100" />

      {/* Panel icon revealed underneath on hover (desktop only) */}
      <span
        aria-hidden
        className="absolute inset-0 hidden scale-90 place-items-center rounded-xl border border-border bg-muted text-foreground opacity-0 transition-all duration-200 ease-out group-hover/toggle:scale-100 group-hover/toggle:opacity-100 group-focus-visible/toggle:scale-100 group-focus-visible/toggle:opacity-100 md:grid"
      >
        <PanelLeft className={cn("size-[18px] transition-transform duration-300", collapsed && "rotate-180")} />
      </span>

      {/* Tooltip, mirrors the panel-toggle affordance */}
      <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-3 hidden -translate-y-1/2 translate-x-[-6px] whitespace-nowrap rounded-lg border border-border px-3 py-2 text-left opacity-0 shadow-soft transition-all duration-200 group-hover/toggle:translate-x-0 group-hover/toggle:opacity-100 group-hover/toggle:delay-300 md:block surface">
        <span className="block text-xs font-semibold leading-tight text-foreground">
          {collapsed ? "Expand" : "Collapse"}
        </span>
        <span className="block text-[11px] leading-tight text-muted-foreground">
          {collapsed ? "Show full sidebar" : "Show icons only"}
        </span>
      </span>
    </button>
  );
}

function RecentRow({
  conv,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  conv: ConversationMeta;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conv.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  useEffect(() => {
    if (editing) {
      setDraft(conv.title);
      // focus after paint
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing, conv.title]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== conv.title) onRename(next);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/60 pl-3 pr-1.5 py-2">
        <Pencil className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          id={inputId}
          ref={inputRef}
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          className="w-full bg-transparent text-sm text-foreground caret-foreground outline-none"
        />
        <button onClick={commit} aria-label="Save" className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <Check className="size-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group/row relative flex items-center rounded-lg pl-3 pr-1.5 py-2 text-sm transition-colors",
        active ? "bg-muted/70 text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
    >
      <button onClick={onSelect} className="min-w-0 flex-1 truncate pr-1 text-left" title={conv.title}>
        {conv.title}
      </button>

      <button
        onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
        aria-label="Conversation options"
        title="Rename or delete"
        className={cn(
          "shrink-0 rounded-md p-1 text-muted-foreground transition-all hover:bg-muted hover:text-foreground",
          menuOpen ? "opacity-100" : "opacity-0 group-hover/row:opacity-100",
        )}
      >
        <MoreHorizontal className="size-4" />
      </button>

      {menuOpen ? (
        <>
          {/* click-away */}
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} aria-hidden />
          <div className="surface absolute right-1 top-8 z-50 w-32 overflow-hidden rounded-lg border border-border shadow-soft">
            <button
              onClick={() => { setMenuOpen(false); setEditing(true); }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground hover:bg-muted"
            >
              <Pencil className="size-3.5" /> Rename
            </button>
            <button
              onClick={() => { setMenuOpen(false); onDelete(); }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="size-3.5" /> Delete
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function NavItem({
  icon,
  label,
  collapsed,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  collapsed: boolean;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={cn(
        "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
        collapsed && "md:justify-center md:px-0",
        active
          ? "bg-muted/70 text-foreground"
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className={cn(collapsed && "md:hidden")}>{label}</span>
    </button>
  );
}
