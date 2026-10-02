import { createContext } from "react";
import type { Status } from "@/lib/api";
import type { Rule, RuleInput, Run, Settings } from "../../src/rules.ts";
import type { T3Project, T3Provider } from "../../src/t3.ts";
import type { UpdateStatus } from "../../src/update.ts";

/**
 * What the app shell loads once and every route can read: connection status,
 * T3 projects and providers, settings with a saver, the update check, and
 * the rules and runs the rules list and run log show.
 */
export type Shell = {
  status: Status | null;
  projects: T3Project[];
  providers: T3Provider[] | null;
  settings: Settings | null;
  saveSettings: (next: Settings) => Promise<void>;
  update: UpdateStatus | null;
  /** Why the last update check failed (no upstream, git error), when it did. */
  updateError: string | null;
  recheckUpdate: () => Promise<void>;
  rules: Rule[] | null;
  selected: Rule | null;
  selectRule: (id: string) => void;
  runs: Run[];
  webhookUrl: string;
  createRule: () => Promise<void>;
  saveRule: (id: string, input: RuleInput) => Promise<void>;
  toggleRule: (rule: Rule) => Promise<void>;
  deleteRule: (rule: Rule) => Promise<void>;
  refreshRuns: () => void;
};

export const ShellContext = createContext<Shell | null>(null);
