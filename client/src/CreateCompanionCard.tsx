import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { companionModelAccess, computeCompanionStats, PAID_COMPANION_MODELS } from "../../server/src/companionModels";
import { iconDonorCompanions } from "./Companions";
import { CompanionAccessNotice } from "./CompanionAccess";
import { displayModelLabel } from "./modelLabel";
import { agentNameHue } from "./agentColor";
import { COMPANION_EFFORTS, customCompanionNameError, soulTemplate } from "./companionCustom";
import "./companions.css";

export type CreateCompanionInput = {
  name: string;
  icon_id: string;
  role: string;
  description: string;
  skills: string[];
  trade_off: string;
  soul: string;
  icon_data_url?: string;
  model_id: string;
  effort: (typeof COMPANION_EFFORTS)[number];
};

const KNOWN_MODELS = ["muse-spark-1.3", "muse-wonder-1.0", "muse-wonder-full-1.0"];

const statLabels = [
  ["speed", "Speed"],
  ["thoughtfulness", "Thoughtfulness"],
  ["creativity", "Creativity"],
  ["initiative", "Initiative"],
] as const;

export function CreateCompanionCard({ models, existingNames, usedIconIds, busy, onCreate }: {
  models?: readonly { id: string }[];
  existingNames: readonly string[];
  usedIconIds: readonly string[];
  busy: boolean;
  onCreate: (input: CreateCompanionInput) => Promise<string | null>;
}) {
  const [name, setName] = useState("");
  const [iconId, setIconId] = useState("");
  const [customImage, setCustomImage] = useState<string | null>(null);
  const [iconOpen, setIconOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [role, setRole] = useState("");
  const [description, setDescription] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [tradeOff, setTradeOff] = useState("");
  const [modelId, setModelId] = useState("muse-spark-1.3");
  const [effort, setEffort] = useState<(typeof COMPANION_EFFORTS)[number]>("medium");
  const [soul, setSoul] = useState(() => soulTemplate(""));
  const [soulEdited, setSoulEdited] = useState(false);
  const [soulOpen, setSoulOpen] = useState(false);
  const [soulEditing, setSoulEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iconWrapRef = useRef<HTMLDivElement>(null);

  const modelOptions = useMemo(() => {
    const ids = new Set<string>(KNOWN_MODELS);
    for (const model of models ?? []) ids.add(model.id);
    ids.add(modelId);
    return [...ids];
  }, [models, modelId]);

  const availableIcons = iconDonorCompanions.filter((option) => !usedIconIds.includes(option.id));
  const donor = iconId && iconId !== "custom" ? iconDonorCompanions.find((item) => item.id === iconId) : undefined;
  const portraitSrc = customImage && iconId === "custom" ? customImage : donor?.artwork.cardStill;
  const stats = computeCompanionStats(modelId, effort);
  const access = companionModelAccess(
    { model: { preferredId: modelId, ifUnavailable: Object.hasOwn(PAID_COMPANION_MODELS, modelId) ? "upgrade-required" : "use-catalog-default" } },
    models,
  );

  useEffect(() => {
    if (!iconOpen) return;
    const close = (event: PointerEvent | FocusEvent) => {
      if (event.target instanceof Node && !iconWrapRef.current?.contains(event.target)) setIconOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setIconOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("focusin", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("focusin", close);
      document.removeEventListener("keydown", escape);
    };
  }, [iconOpen]);

  const nameError = useMemo(() => customCompanionNameError(name, existingNames), [name, existingNames]);
  const missingRequired = name.trim().length === 0 || role.trim().length === 0 || iconId.length === 0;
  const canCreate = !missingRequired && !nameError && !busy;

  const onPickImage = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError("Pick an image file."); return; }
    if (file.size > 2 * 1024 * 1024) { setError("Image must be 2 MB or smaller."); return; }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setCustomImage(reader.result);
        setIconId("custom");
        setIconOpen(false);
        setError(null);
      }
    };
    reader.onerror = () => setError("That image could not be read.");
    reader.readAsDataURL(file);
  };

  const updateName = (value: string) => {
    setName(value);
    setError(null);
    if (!soulEdited) setSoul(soulTemplate(value));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canCreate) return;
    setError(null);
    const failure = await onCreate({
      name: name.trim(),
      icon_id: iconId,
      role: role.trim(),
      description: description.trim(),
      skills: skills.map((skill) => skill.trim()).filter(Boolean),
      trade_off: tradeOff.trim(),
      soul,
      ...(iconId === "custom" && customImage ? { icon_data_url: customImage } : {}),
      model_id: modelId,
      effort,
    });
    if (failure) setError(failure);
  };

  return (
    <form className="companion-card companion-create-card" onSubmit={submit} aria-labelledby="create-companion-heading"
      style={{ "--companion-hue": agentNameHue(name.trim() || "new companion") } as CSSProperties}>
      <h2 id="create-companion-heading" className="companion-sr-only">Add a companion</h2>

      <div className="companion-card-identity">
        <div className="companion-card-portrait companion-create-portrait" ref={iconWrapRef}>
          <button type="button" className="companion-icon-trigger" aria-haspopup="listbox" aria-expanded={iconOpen}
            aria-label={donor ? "Change icon" : "Pick an icon"} disabled={busy} onClick={() => setIconOpen((value) => !value)}>
            {portraitSrc
              ? <img src={portraitSrc} width={256} height={256} alt="" />
              : <span className="companion-icon-blank"><span aria-hidden="true">＋</span><span>Pick icon</span></span>}
          </button>
          {!iconId && <span className="companion-required-asterisk companion-icon-required" aria-hidden="true">*</span>}
          {iconOpen && (
            <div className="companion-icon-dropdown" role="listbox" aria-label="Available icons">
              {availableIcons.map((option) => (
                <button key={option.id} type="button" role="option" aria-selected={option.id === iconId}
                  aria-label={option.character} className={`companion-icon-option${option.id === iconId ? " selected" : ""}`}
                  onClick={() => { setIconId(option.id); setIconOpen(false); setError(null); }}>
                  <img src={option.artwork.still} width={52} height={52} alt="" />
                </button>
              ))}
              <button type="button" role="option" aria-selected={iconId === "custom"}
                aria-label="Upload your own image" title="Upload your own image" className={`companion-icon-option companion-icon-upload${iconId === "custom" ? " selected" : ""}`}
                onClick={() => fileInputRef.current?.click()}>
                {customImage
                  ? <img src={customImage} width={52} height={52} alt="" />
                  : <span className="companion-icon-upload-plus" aria-hidden="true">＋</span>}
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" className="companion-sr-only" aria-label="Upload your own image"
                onChange={(event) => { onPickImage(event.target.files?.[0]); event.target.value = ""; }} />
            </div>
          )}
        </div>
        <header className="companion-card-heading companion-create-heading">
          <span className="companion-field-wrap">
            <input type="text" className="companion-card-role companion-create-role" value={role} maxLength={80}
              placeholder="Role (e.g. The tidy organizer)" aria-label="Role (required). A short title, for example The tidy organizer" autoComplete="off" disabled={busy}
              onChange={(event) => setRole(event.target.value)} />
            {!role.trim() && <span className="companion-required-asterisk companion-field-required" aria-hidden="true">*</span>}
          </span>
          <span className="companion-field-wrap">
            <input type="text" className="companion-create-name" value={name} maxLength={40}
              placeholder="Name" aria-label="Name (required)" autoComplete="off" spellCheck={false} data-autofocus disabled={busy}
              onChange={(event) => updateName(event.target.value)} />
            {!name.trim() && <span className="companion-required-asterisk companion-field-required" aria-hidden="true">*</span>}
          </span>
          <input type="text" className="companion-create-description" value={description} maxLength={240}
            placeholder="What this companion helps with" aria-label="Description" autoComplete="off" disabled={busy}
            onChange={(event) => setDescription(event.target.value)} />
        </header>
      </div>
      {nameError && <p className="confirm-dialog-error" role="alert">{nameError}</p>}

      <div className="companion-card-access">
        <CompanionAccessNotice access={access} modelName={displayModelLabel(modelId)} compact />
      </div>

      <dl className="companion-stats" aria-label="Working style ratings">
        {statLabels.map(([key, label]) => (
          <div className="companion-stat" key={key}>
            <dt>{label}</dt>
            <dd aria-label={`${stats[key]} out of 5`}>
              <span className="companion-stat-bars" aria-hidden="true">
                {[1, 2, 3, 4, 5].map((level) => <span key={level} className={level <= stats[key] ? "filled" : ""} />)}
              </span>
            </dd>
          </div>
        ))}
      </dl>

      <section className="companion-skills" aria-labelledby="create-skills-heading">
        <h3 id="create-skills-heading">Best at</h3>
        <div className="companion-create-skills">
          {skills.map((skill, index) => (
            <span key={index} className="companion-create-skill-wrap">
              <input type="text" className="companion-create-skill" value={skill} maxLength={40}
                placeholder="Skill" autoComplete="off" disabled={busy} aria-label={`Skill ${index + 1}`} autoFocus={index === skills.length - 1}
                onChange={(event) => setSkills((prev) => prev.map((item, i) => i === index ? event.target.value : item))} />
              <button type="button" className="companion-create-skill-remove" aria-label={`Remove skill ${index + 1}`} disabled={busy}
                onClick={() => setSkills((prev) => prev.filter((_, i) => i !== index))}>×</button>
            </span>
          ))}
          {skills.length < 3 && (
            <button type="button" className="companion-create-skill companion-create-add-skill" disabled={busy}
              onClick={() => setSkills((prev) => [...prev, ""])}>
              + Add skill
            </button>
          )}
        </div>
      </section>

      <section className="companion-tradeoff" aria-labelledby="create-tradeoff-heading">
        <h3 id="create-tradeoff-heading">The trade-off</h3>
        <textarea className="companion-create-tradeoff" value={tradeOff} maxLength={240} rows={2}
          placeholder="What this companion is not best for" aria-label="The trade-off" disabled={busy}
          onChange={(event) => setTradeOff(event.target.value)} />
      </section>

      <section className="companion-details companion-create-details">
        <dl className="companion-configuration">
          <div>
            <dt><label htmlFor="create-companion-model">Preferred model</label></dt>
            <dd>
              <select id="create-companion-model" className="companion-create-select" value={modelId} disabled={busy}
                onChange={(event) => setModelId(event.target.value)}>
                {modelOptions.map((id) => <option key={id} value={id}>{displayModelLabel(id)}</option>)}
              </select>
            </dd>
          </div>
          <div>
            <dt><label htmlFor="create-companion-effort">Effort</label></dt>
            <dd>
              <select id="create-companion-effort" className="companion-create-select" value={effort} disabled={busy}
                onChange={(event) => setEffort(event.target.value as (typeof COMPANION_EFFORTS)[number])}>
                {COMPANION_EFFORTS.map((value) => <option key={value} value={value}>{value === "xhigh" ? "Extra high" : value[0]!.toUpperCase() + value.slice(1)}</option>)}
              </select>
            </dd>
          </div>
        </dl>
        <p className="companion-ratings-note">Ratings are computed from model and effort. Skills and trade-off describe the companion; they do not change its behavior.</p>
        <details className="companion-soul companion-create-soul" open={soulOpen}
          onToggle={(event) => {
            const open = event.currentTarget.open;
            setSoulOpen(open);
            if (!open) setSoulEditing(false);
          }}>
          <summary>SOUL.md</summary>
          {soulOpen && (
            <div className="companion-soul-edit-row">
              <div className="companion-soul-edit-content">
                {soulEditing
                  ? <textarea className="companion-create-soul-text" value={soul} rows={10} maxLength={8000} disabled={busy} aria-label="SOUL.md" autoFocus
                      onChange={(event) => { setSoul(event.target.value); setSoulEdited(true); }} />
                  : <pre>{soul}</pre>}
              </div>
              <button type="button" className={`companion-soul-edit-button${soulEditing ? " pressed" : ""}`} disabled={busy}
                aria-expanded={soulEditing} aria-pressed={soulEditing}
                title={soulEditing ? "Save SOUL.md" : "Edit SOUL.md"}
                onClick={() => setSoulEditing((value) => !value)}>
                {soulEditing ? "Save" : "Edit"}
              </button>
            </div>
          )}
        </details>
      </section>

      {error && <p className="confirm-dialog-error" role="alert">{error}</p>}
      <div className="companion-create-footer">
        {missingRequired && <p className="companion-create-required-hint"><span className="companion-required-asterisk" aria-hidden="true">*</span> Required items must be provided.</p>}
        <div className="confirm-dialog-actions companion-create-actions">
          <button type="submit" className="confirm-dialog-primary companion-create-submit" disabled={!canCreate}>{busy ? "Adding…" : "Add companion"}</button>
        </div>
      </div>
    </form>
  );
}
