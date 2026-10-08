import { MUSE_MODEL_BILLING_URL, type CompanionModelAccess } from "../../server/src/companionModels";

export function CompanionLock() {
  return <svg className="companion-lock" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <rect x="3.5" y="7" width="9" height="7" rx="2" />
    <path d="M5.5 7V4.5a2.5 2.5 0 0 1 5 0V7" />
  </svg>;
}

export function CompanionAccessNotice({ access, modelName, compact = false }: { access: CompanionModelAccess; modelName: string; compact?: boolean }) {
  if (access.status === "ready") return null;
  return <div className="companion-access-notice" role="status">
    {access.status === "upgrade-required" ? <>
      <span title={compact ? modelName : undefined}><CompanionLock /> Upgrade required{!compact && ` · ${modelName}`}</span>
      <a href={MUSE_MODEL_BILLING_URL} target="_blank" rel="noopener noreferrer" aria-label="Upgrade in Muse Model API">{compact ? "Upgrade ↗" : "Upgrade in Muse Model API ↗"}</a>
    </> : <span><CompanionLock /> This model is unavailable.</span>}
  </div>;
}
