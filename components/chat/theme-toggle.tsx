"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

const THEME_OPTIONS = [
  { icon: SunIcon, label: "Light", value: "light" },
  { icon: MoonIcon, label: "Dark", value: "dark" },
  { icon: MonitorIcon, label: "System", value: "system" },
] as const;

const [, , FALLBACK_OPTION] = THEME_OPTIONS;

/**
 * Cycles between light, dark and system via a dropdown rather than a
 * two-way toggle, since the provider is configured with
 * `defaultTheme="system"` — a plain flip would have no way back to
 * "follow the system".
 *
 * `theme` is only trusted once mounted: the server has no access to the
 * client's stored preference, so rendering it during the initial client
 * render (before hydration settles) would mismatch the server-rendered
 * markup and either warn or flash the wrong icon. Both server and the
 * pre-mount client render fall back to the same "system" option, and the
 * real value swaps in only after the effect runs.
 */
export function ThemeToggle() {
  const { setTheme, theme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const current = mounted
    ? (THEME_OPTIONS.find((option) => option.value === theme) ??
      FALLBACK_OPTION)
    : FALLBACK_OPTION;
  const CurrentIcon = current.icon;
  const accessibleName = `Theme: ${current.label}`;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              aria-label={accessibleName}
              className="text-sidebar-foreground/70 hover:text-sidebar-foreground"
              tooltip={accessibleName}
            >
              <CurrentIcon />
              <span>{current.label}</span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
            <DropdownMenuRadioGroup
              onValueChange={setTheme}
              value={current.value}
            >
              {THEME_OPTIONS.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  <option.icon />
                  <span>{option.label}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
