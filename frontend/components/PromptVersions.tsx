import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, timeAgo } from "@/lib/api";
import type { PromptHistory } from "../../src/promptVersions.ts";
import type { PromptVersion } from "../../src/rules.ts";
import type { PromptOwner } from "../../src/shared.ts";

/*
 * Versions of a preset or rule prompt in its editor. The draft starts from
 * the latest version; picking another version in the select shows it
 * read-only, with "Promote" to make it live and "Edit from this" to make it
 * the draft's base. Saving appends a version: a draft runs ignore, unless
 * promoted.
 */

const path = (owner: PromptOwner, id: string) => `/api/${owner === "preset" ? "prompts" : "rules"}/${id}/versions`;
const key = (owner: PromptOwner, id: string) => ["prompt-versions", owner, id];

/** A prompt's versions, newest first; editors render once this has loaded. */
export function usePromptHistory(owner: PromptOwner, id: string) {
  return useQuery({ queryKey: key(owner, id), queryFn: () => api<PromptHistory>(path(owner, id)) });
}

export function usePromptVersions(history: PromptHistory) {
  const { owner, id, liveVersion, latestVersion, versions } = history;
  const queryClient = useQueryClient();
  const [base, setBase] = useState(latestVersion);
  const [viewing, setViewing] = useState<number | null>(null);
  const bodyOf = (version: number) => versions.find((v) => v.version === version)?.body ?? "";

  const post = async (url: string, body?: object) => {
    const next = await api<PromptHistory>(url, { method: "POST", body: body && JSON.stringify(body) });
    queryClient.setQueryData(key(owner, id), next);
    // Promoting a preset changes the body dispatches and linked rules use.
    if (owner === "preset") void queryClient.invalidateQueries({ queryKey: ["prompts"] });
    return next;
  };

  return {
    history,
    base,
    /** Body the draft started from: unsaved while the editor's text differs. */
    baseBody: bodyOf(base),
    /** The version shown read-only instead of the draft, if any. */
    viewed: viewing === null ? null : (versions.find((v) => v.version === viewing) ?? null),
    view: (version: number) => setViewing(version === base ? null : version),
    /** Makes a version the draft's base and returns its body for the editor. */
    editFrom: (version: number) => {
      setBase(version);
      setViewing(null);
      return bodyOf(version);
    },
    /** Back to the latest version; returns its body for the editor. */
    reset: () => {
      setBase(latestVersion);
      setViewing(null);
      return bodyOf(latestVersion);
    },
    /** Appends `body` as a version when it changed, promoting it when asked; unchanged, `promote` promotes the base. */
    save: async (body: string, promote: boolean) => {
      if (body !== bodyOf(base)) {
        const next = await post(path(owner, id), { body, promote });
        setBase(next.latestVersion);
      } else if (promote && base !== liveVersion) {
        await post(`${path(owner, id)}/${base}/promote`);
      }
    },
    promote: (version: number) => post(`${path(owner, id)}/${version}/promote`),
  };
}

export type PromptVersions = ReturnType<typeof usePromptVersions>;

/** Select of versions with the live one marked; on another version, Promote and Edit from this. */
export function VersionSelect({ versions, onEditFrom }: { versions: PromptVersions; onEditFrom: (body: string) => void }) {
  const { history, base, viewed } = versions;
  const [busy, setBusy] = useState(false);
  const shown = viewed?.version ?? base;
  const promote = (version: number) => {
    setBusy(true);
    versions.promote(version).finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Select value={String(shown)} onValueChange={(v) => versions.view(Number(v))}>
        <SelectTrigger size="sm" className="font-mono text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          {history.versions.map((version) => (
            <SelectItem key={version.version} value={String(version.version)} title={version.note ?? undefined}>
              <VersionLabel version={version} live={history.liveVersion} editing={version.version === base} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {shown !== history.liveVersion && <span className="text-muted-foreground">live is v{history.liveVersion}</span>}
      {viewed && (
        <>
          {viewed.version !== history.liveVersion && (
            <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => promote(viewed.version)}>
              Promote v{viewed.version}
            </Button>
          )}
          <Button type="button" size="xs" variant="ghost" className="text-primary" onClick={() => onEditFrom(versions.editFrom(viewed.version))}>
            Edit from this
          </Button>
        </>
      )}
    </div>
  );
}

function VersionLabel({ version, live, editing }: { version: PromptVersion; live: number; editing: boolean }) {
  const state = version.version === live ? "live" : version.version > live ? "draft" : null;
  return (
    <span>
      v{version.version}
      {state && <span className={state === "live" ? "text-ok" : "text-active"}> · {state}</span>}
      {editing && " · editing"}
      <span className="text-muted-foreground">
        {" "}
        · {version.source} · {timeAgo(version.createdAt)}
      </span>
    </span>
  );
}
