import type { CompanionStats } from "../../server/src/companionModels";

const stats = [
  ["speed", "Speed"],
  ["thoughtfulness", "Thoughtfulness"],
  ["creativity", "Creativity"],
  ["initiative", "Initiative"],
] as const;

export function CompanionMiniStats({ ratings }: {
  ratings?: CompanionStats;
}) {
  const description = ratings
    ? stats.map(([key, label]) => `${label}: ${ratings[key]} out of 5`).join(", ")
    : "Working style ratings unavailable";
  return <span className="companion-mini-stats"
    role="img" aria-label={description}>
    {stats.map(([key, label]) => <span className="companion-mini-stat" key={key} aria-hidden="true">
      <span className="companion-mini-stat-label">{label}</span>
      <span className="companion-mini-stat-bars">
        {[1, 2, 3, 4, 5].map((level) => <span key={level} className={ratings && level <= ratings[key] ? "filled" : ""} />)}
      </span>
    </span>)}
  </span>;
}
