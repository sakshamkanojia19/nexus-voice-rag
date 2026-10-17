import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";

const KEY = "ucb_theme";

function resolveSystem(): "light" | "dark" {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function apply(theme: Theme): void {
  const effective = theme === "system" ? resolveSystem() : theme;
  document.documentElement.classList.toggle("dark", effective === "dark");
  document.documentElement.style.colorScheme = effective;
}

export function useTheme(): {
  theme: Theme;
  setTheme: (t: Theme) => void;
  effective: "light" | "dark";
} {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === "undefined") return "system";
    return (localStorage.getItem(KEY) as Theme | null) ?? "system";
  });
  const [effective, setEffective] = useState<"light" | "dark">(() =>
    typeof window === "undefined" ? "light" : theme === "system" ? resolveSystem() : theme,
  );

  useEffect(() => {
    apply(theme);
    localStorage.setItem(KEY, theme);
    setEffective(theme === "system" ? resolveSystem() : theme);
  }, [theme]);

  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (): void => {
      apply("system");
      setEffective(resolveSystem());
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);

  return { theme, setTheme, effective };
}
