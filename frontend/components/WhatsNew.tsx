import { useEffect, useState } from "react";
import { Confetti } from "@/components/ui/Confetti";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { Changes, Release } from "../../src/update.ts";

/** The commit the UI last saw this server run, to tell a restart onto new code from a plain reload. */
const SEEN_COMMIT_KEY = "mergeatron.seen-commit";

/**
 * After the server restarts onto new code, asks what changed since the commit
 * the UI last saw and, when a first-time contributor is among it, celebrates
 * with confetti and a list of the changes. The first visit only records the commit.
 */
export function WhatsNew() {
  const [changes, setChanges] = useState<{ current: string; release: Release } | null>(null);

  useEffect(() => {
    const seen = localStorage.getItem(SEEN_COMMIT_KEY);
    api<Changes>(`/api/update/changes${seen ? `?from=${seen}` : ""}`)
      .then(({ current, release }) => {
        localStorage.setItem(SEEN_COMMIT_KEY, current);
        if (release && release.newContributors.length > 0) setChanges({ current, release });
      })
      .catch(() => {});
  }, []);

  if (!changes) return null;
  const { current, release } = changes;
  return (
    <>
      <Confetti />
      <Dialog open onOpenChange={(open) => !open && setChanges(null)}>
        <DialogContent className="max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Updated to {current}</DialogTitle>
          </DialogHeader>
          <p className="text-sm">
            New contributor{release.newContributors.length > 1 && "s"}:{" "}
            {release.newContributors.map((login, index) => (
              <span key={login}>
                {index > 0 && ", "}
                <span className="font-mono font-medium">{login}</span>
              </span>
            ))}
          </p>
          <ul className="grid gap-1.5 text-[13px]">
            {release.commits.map((commit) => (
              <li key={commit.sha} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0">{commit.subject}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{commit.author}</span>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
