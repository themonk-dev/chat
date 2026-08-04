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
 * A dropdown rather than a two-way toggle, so "follow the system" stays
 * reachable. `theme` is only trusted once mounted: the server cannot know the
 * stored preference, and rendering it before hydration flashes the wrong icon.
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
