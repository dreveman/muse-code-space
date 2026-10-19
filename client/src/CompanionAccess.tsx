import { MUSE_MODEL_BILLING_URL, type CompanionModelAccess } from "../../server/src/companionModels";

export function CompanionLock() {
  return <svg className="companion-lock" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <rect x="3.5" y="7" width="9" height="7" rx="2" />
    <path d="M5.5 7V4.5a2.5 2.5 0 0 1 5 0V7" />
  </svg>;
}

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16" color="currentColor" aria-hidden="true">
      <path d="M3.46 14.89h9.143a2.292 2.292 0 0 0 2.286-2.286v-1.523a.764.764 0 0 0-.762-.762.764.764 0 0 0-.762.761v1.524a.764.764 0 0 1-.762.762H3.46a.764.764 0 0 1-.762-.762V3.461c0-.419.343-.761.762-.761h1.524c.42 0 .762-.343.762-.762a.764.764 0 0 0-.762-.762H3.46A2.292 2.292 0 0 0 1.175 3.46v9.143A2.292 2.292 0 0 0 3.46 14.89z" />
      <path d="M7.27 1.938c0 .419.343.762.762.762h4.259L5.974 9.016a.759.759 0 0 0 .541 1.295.78.78 0 0 0 .541-.22l6.317-6.317v4.259c0 .419.342.762.761.762.42 0 .762-.343.762-.762V1.938a.764.764 0 0 0-.762-.762H8.04a.764.764 0 0 0-.762.762H7.27z" />
    </svg>
  );
}

export function CompanionAccessNotice({ access, modelName, compact = false }: { access: CompanionModelAccess; modelName: string; compact?: boolean }) {
  if (access.status === "ready") return null;
  return <div className="companion-access-notice" role="status">
    {access.status === "upgrade-required" ? <>
      <span title={compact ? modelName : undefined}><CompanionLock /> Upgrade required{!compact && ` · ${modelName}`}</span>
      <a href={MUSE_MODEL_BILLING_URL} target="_blank" rel="noopener noreferrer" aria-label="Upgrade in Muse Model API">
        <span>{compact ? "Upgrade" : "Upgrade in Muse Model API"}</span>
        <ExternalLinkIcon />
      </a>
    </> : <span><CompanionLock /> This model is unavailable.</span>}
  </div>;
}
