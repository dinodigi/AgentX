"use client";

import { useState } from "react";
import { Moon, Sun } from "lucide-react";

/**
 * Global workspace theme toggle. Flips [data-theme] on the shell root
 * immediately (no reload) and persists a cookie so SSR matches next load.
 */
export function ThemeToggle({ initial }: { initial: "dark" | "light" }) {
  const [theme, setTheme] = useState(initial);
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.querySelector("[data-theme-root]")?.setAttribute("data-theme", next);
    document.cookie = `ax_theme=${next};path=/;max-age=31536000;samesite=lax`;
  };
  return (
    <button
      type="button"
      onClick={flip}
      aria-label={theme === "dark" ? "Switch to light" : "Switch to dark"}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-mute transition-colors hover:bg-raised hover:text-ink"
      title={theme === "dark" ? "Light mode" : "Dark mode"}
    >
      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
