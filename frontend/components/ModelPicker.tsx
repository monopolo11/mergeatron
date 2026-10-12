import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ModelSelection } from "../../src/rules.ts";
import type { T3Model, T3Provider } from "../../src/t3.ts";

/** Select value for "no reasoning option sent": T3 uses the model's default. */
const DEFAULT_REASONING = "default";

/** Options kept on a switch to model `to`: those it offers with the same value; the rest belonged to the old model. */
function carryOptions(options: ModelSelection["options"], to: T3Model | undefined): Pick<ModelSelection, "options"> {
  const kept = (options ?? []).filter((option) =>
    to?.options.some((offered) =>
      offered.id === option.id &&
      (offered.type === "boolean" ? typeof option.value === "boolean" : offered.choices.some((c) => c.id === option.value)),
    ),
  );
  return kept.length > 0 ? { options: kept } : {};
}

/**
 * Provider instance, model and reasoning pickers fed by T3's own provider
 * config. Disabled instances still appear (marked) so an existing selection
 * stays visible; the model list falls back to free text when T3 is
 * unreachable or the instance has no catalog. The reasoning picker shows
 * only for models that offer levels.
 */
export function ModelPicker({
  value,
  providers,
  onChange,
  className,
}: {
  value: ModelSelection;
  providers: T3Provider[] | null;
  onChange: (value: ModelSelection) => void;
  className?: string;
}) {
  const provider = providers?.find((p) => p.instanceId === value.instanceId) ?? null;
  const models = provider?.models ?? [];
  const current = models.find((m) => m.slug === value.model);
  const known = current !== undefined;
  // T3's own picker shows the first select option as the reasoning level (`TraitsPicker.tsx`).
  const reasoning = current?.options.find((o) => o.type === "select") ?? null;
  const picked = reasoning && value.options?.find((o) => o.id === reasoning.id)?.value;
  const level = typeof picked === "string" ? picked : DEFAULT_REASONING;
  const defaultLevel = reasoning?.choices.find((c) => c.isDefault)?.label;
  const instanceOptions = providers ?? [];
  const instanceKnown = instanceOptions.some((p) => p.instanceId === value.instanceId);

  const pickInstance = (instanceId: string) => {
    const next = providers?.find((p) => p.instanceId === instanceId);
    const preferred = next?.models.find((m) => m.isDefault) ?? next?.models.find((m) => !m.isLegacy) ?? next?.models[0];
    onChange({ instanceId, model: preferred?.slug ?? value.model, ...carryOptions(value.options, preferred) });
  };

  const pickModel = (model: string) =>
    onChange({ instanceId: value.instanceId, model, ...carryOptions(value.options, models.find((m) => m.slug === model)) });

  const pickReasoning = (id: string) => {
    if (!reasoning) return;
    const others = (value.options ?? []).filter((o) => o.id !== reasoning.id);
    const options = id === DEFAULT_REASONING ? others : [...others, { id: reasoning.id, value: id }];
    const { options: _, ...rest } = value;
    onChange(options.length > 0 ? { ...rest, options } : rest);
  };

  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {providers ? (
        <Select value={value.instanceId} onValueChange={pickInstance}>
          <SelectTrigger size="sm" className="w-44"><SelectValue placeholder="provider" /></SelectTrigger>
          <SelectContent>
            {!instanceKnown && <SelectItem value={value.instanceId}>{value.instanceId}</SelectItem>}
            {instanceOptions.map((p) => (
              <SelectItem key={p.instanceId} value={p.instanceId} disabled={!p.enabled && p.instanceId !== value.instanceId}>
                {p.displayName}
                {!p.enabled && <span className="ml-1 text-muted-foreground">disabled</span>}
                {p.enabled && p.status !== "ready" && <span className="ml-1 text-warn">{p.status}</span>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input className="w-44" value={value.instanceId} onChange={(e) => onChange({ ...value, instanceId: e.target.value })} placeholder="provider instance" />
      )}

      {models.length > 0 ? (
        <Select value={value.model} onValueChange={pickModel}>
          <SelectTrigger size="sm" className="w-60"><SelectValue placeholder="model" /></SelectTrigger>
          <SelectContent>
            {!known && <SelectItem value={value.model}>{value.model}</SelectItem>}
            {models.filter((m) => !m.isLegacy).map((m) => (
              <SelectItem key={m.slug} value={m.slug}>
                {m.name}
                {m.isDefault && <span className="ml-1 text-muted-foreground">default</span>}
              </SelectItem>
            ))}
            {models.some((m) => m.isLegacy) && (
              <div className="px-2 pt-1.5 pb-0.5 text-[11px] tracking-wide text-muted-foreground uppercase">Legacy</div>
            )}
            {models.filter((m) => m.isLegacy).map((m) => (
              <SelectItem key={m.slug} value={m.slug} className="text-muted-foreground">{m.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input className="w-60" value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })} placeholder="model slug" />
      )}

      {reasoning && (
        <Select value={level} onValueChange={pickReasoning}>
          <SelectTrigger size="sm" className="w-40"><SelectValue placeholder="reasoning" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_REASONING}>
              Default
              {defaultLevel && <span className="ml-1 text-muted-foreground">{defaultLevel}</span>}
            </SelectItem>
            {level !== DEFAULT_REASONING && !reasoning.choices.some((c) => c.id === level) && <SelectItem value={level}>{level}</SelectItem>}
            {reasoning.choices.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
