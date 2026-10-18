import { Fragment, useState } from "react";
import { formatRelativeTime } from "./sessionList";
import {
  SMARTLOG_CELL_WIDTH,
  computeSmartlogLayout,
  displaySmartlogBookmarks,
  filterSmartlogForDisplay,
  smartlogLaneCenterX,
  type SessionVcsStatus,
  type SmartlogFile,
  type SmartlogLaneCell,
} from "./smartlogLayout";

const ROW_HEIGHT = 28;
const LINE_WIDTH = 2;
const NODE_RADIUS = 6;
const ANCESTOR_DASH = "3,2";
const FILE_LIST_CAP = 10;

function xpos(lane: number): number {
  return lane * SMARTLOG_CELL_WIDTH + SMARTLOG_CELL_WIDTH / 2;
}

function RefreshIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M5.5 9A7 7 0 0 1 18 7l2 5M4 12l2 5a7 7 0 0 0 12.5-2" />
    </svg>
  );
}

/** The Sapling "sl" Smart Log icon (from DmHqSmartLogIcon.svg.react.js). */
export function SmartLogIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      viewBox="0 -3 24 24"
    >
      <path d="M8.25031 2.25C7.37576 2.25 4.50027 2.25 4.50027 2.25C1.50036 2.25 0.000265479 8.25 6.00031 8.25C12.0004 8.25 11.2503 15.7501 8.25031 15.7501C8.25031 15.7501 6.48353 15.7501 5.25031 15.7501M18.7503 15.7501H14.2502V4.5" />
      <circle cx="21" cy="15" r="2.25" />
      <circle cx="13.4997" cy="3.00004" r="2.25" />
      <circle cx="3" cy="15" r="2.25" />
    </svg>
  );
}

function SmartLogGraphRailPassThrough({
  capHeadLane = false,
  headLane,
  joins,
  laneState,
  maxLanes,
  splits,
}: {
  capHeadLane?: boolean;
  headLane: number;
  joins: readonly number[];
  laneState: readonly SmartlogLaneCell[];
  maxLanes: number;
  splits: readonly number[];
}) {
  const width = Math.max(maxLanes, 1) * SMARTLOG_CELL_WIDTH;
  const lanes: Array<{ dashed: boolean; head: boolean; lane: number; startY: number }> = [
    { dashed: false, head: true, lane: headLane, startY: capHeadLane ? 0.5 : 0 },
  ];
  laneState.forEach((cell, index) => {
    if (index === headLane) return;
    if (cell.type === "ancestor") {
      lanes.push({ dashed: true, head: false, lane: index, startY: 0 });
    } else if (cell.type === "vertical" && !splits.includes(index)) {
      lanes.push({ dashed: false, head: false, lane: index, startY: 0 });
    } else if (cell.type === "empty" && joins.includes(index)) {
      lanes.push({ dashed: false, head: false, lane: index, startY: 0 });
    }
  });

  return (
    <div className="smartlog-rail">
      <svg
        className="smartlog-rail-tail"
        aria-hidden="true"
        preserveAspectRatio="none"
        viewBox={`0 0 ${width} 1`}
        width={width}
      >
        {lanes.map((cell) => (
          <line
            key={cell.lane}
            className={cell.head ? "smartlog-stroke-head" : "smartlog-stroke-rail"}
            strokeDasharray={cell.dashed ? ANCESTOR_DASH : undefined}
            strokeWidth={LINE_WIDTH}
            vectorEffect="non-scaling-stroke"
            x1={xpos(cell.lane)}
            x2={xpos(cell.lane)}
            y1={cell.startY}
            y2={1}
          />
        ))}
      </svg>
    </div>
  );
}

function SmartLogGraphRail({
  ancestorAbove,
  ancestorBelow,
  converges,
  isHead,
  joins,
  lane,
  laneState,
  line,
  maxLanes,
  ownLaneBelow,
  splits,
}: {
  ancestorAbove: boolean;
  ancestorBelow: boolean;
  converges: readonly number[];
  isHead: boolean;
  joins: readonly number[];
  lane: number;
  laneState: readonly SmartlogLaneCell[];
  line: string;
  maxLanes: number;
  ownLaneBelow: boolean;
  splits: readonly number[];
}) {
  const width = Math.max(maxLanes, 1) * SMARTLOG_CELL_WIDTH;
  const midY = ROW_HEIGHT / 2;
  const overlap = 6;
  const nodeChar = line.charAt(lane) === "" ? "x" : line.charAt(lane);
  const connectedAbove = nodeChar === "o" || nodeChar === "^";
  const drawBelowVertical = ownLaneBelow || ancestorBelow;

  const headerPaths: Array<{ d: string; dashed: boolean; head: boolean }> = [];
  const tailLanes: Array<{ dashed: boolean; lane: number }> = [];
  const nodeX = xpos(lane);

  if (connectedAbove) {
    headerPaths.push({
      d: `M ${nodeX} ${midY} L ${nodeX} ${-overlap}`,
      dashed: ancestorAbove,
      head: isHead,
    });
  } else if (isHead) {
    headerPaths.push({
      d: `M ${nodeX} ${midY} L ${nodeX} ${-overlap}`,
      dashed: false,
      head: true,
    });
  }

  if (drawBelowVertical) {
    headerPaths.push({
      d: `M ${nodeX} ${midY} L ${nodeX} ${ROW_HEIGHT + overlap}`,
      dashed: ancestorBelow,
      head: false,
    });
    tailLanes.push({ dashed: ancestorBelow, lane });
  }

  laneState.forEach((cell, index) => {
    if (index === lane) return;
    const x = xpos(index);
    if (cell.type === "ancestor") {
      headerPaths.push({
        d: `M ${x} ${-overlap} L ${x} ${ROW_HEIGHT + overlap}`,
        dashed: true,
        head: false,
      });
      tailLanes.push({ dashed: true, lane: index });
    } else if (cell.type === "vertical") {
      if (!splits.includes(index)) {
        headerPaths.push({
          d: `M ${x} ${-overlap} L ${x} ${ROW_HEIGHT + overlap}`,
          dashed: false,
          head: false,
        });
      }
      tailLanes.push({ dashed: false, lane: index });
    }
  });

  for (const joinLane of joins) {
    const fromX = xpos(joinLane);
    headerPaths.push({
      d: `M ${fromX} ${-overlap} C ${fromX} ${midY / 2} ${nodeX} ${midY / 2} ${nodeX} ${midY}`,
      dashed: false,
      head: false,
    });
  }
  for (const splitLane of splits) {
    const toX = xpos(splitLane);
    headerPaths.push({
      d: `M ${nodeX} ${midY} C ${nodeX} ${(3 * ROW_HEIGHT) / 4} ${toX} ${(3 * ROW_HEIGHT) / 4} ${toX} ${ROW_HEIGHT + overlap}`,
      dashed: false,
      head: false,
    });
  }
  for (const convergeLane of converges) {
    const toX = xpos(convergeLane);
    headerPaths.push({
      d: `M ${nodeX} ${midY} C ${nodeX} ${(3 * ROW_HEIGHT) / 4} ${toX} ${(3 * ROW_HEIGHT) / 4} ${toX} ${ROW_HEIGHT + overlap}`,
      dashed: false,
      head: false,
    });
  }

  return (
    <div className="smartlog-rail">
      <svg className="smartlog-rail-head" aria-hidden="true" height={ROW_HEIGHT} width={width}>
        {headerPaths.map((path, index) => (
          <path
            key={index}
            d={path.d}
            fill="none"
            className={path.head ? "smartlog-stroke-head" : "smartlog-stroke-rail"}
            strokeDasharray={path.dashed ? ANCESTOR_DASH : undefined}
            strokeWidth={LINE_WIDTH}
          />
        ))}
        {nodeChar !== "x" || isHead ? (
          <circle
            cx={nodeX}
            cy={midY}
            className={isHead ? "smartlog-node-head" : "smartlog-node-rail"}
            r={NODE_RADIUS}
          />
        ) : (
          <circle
            cx={nodeX}
            cy={midY}
            fill="none"
            className="smartlog-stroke-rail"
            r={NODE_RADIUS - 1}
            strokeDasharray="2,2"
            strokeWidth={LINE_WIDTH}
          />
        )}
      </svg>
      {tailLanes.length > 0 && (
        <svg
          className="smartlog-rail-tail"
          aria-hidden="true"
          preserveAspectRatio="none"
          viewBox={`0 0 ${width} 1`}
          width={width}
        >
          {tailLanes.map((tail) => (
            <line
              key={tail.lane}
              className="smartlog-stroke-rail"
              strokeDasharray={tail.dashed ? ANCESTOR_DASH : undefined}
              strokeWidth={LINE_WIDTH}
              vectorEffect="non-scaling-stroke"
              x1={xpos(tail.lane)}
              x2={xpos(tail.lane)}
              y1={0}
              y2={1}
            />
          ))}
        </svg>
      )}
    </div>
  );
}

function SmartLogUncommittedBlock({
  files,
  totalAdditions,
  totalDeletions,
  uncommittedFileCount,
  onOpenFile,
}: {
  files: readonly SmartlogFile[];
  totalAdditions: number;
  totalDeletions: number;
  uncommittedFileCount: number;
  onOpenFile?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visibleFiles = expanded ? files : files.slice(0, FILE_LIST_CAP);

  return (
    <div className="smartlog-uncommitted">
      <div className="smartlog-uncommitted-summary">
        <span className="smartlog-dirty-dot" aria-hidden="true" />
        <span className="smartlog-uncommitted-label">
          {uncommittedFileCount} uncommitted {uncommittedFileCount === 1 ? "file" : "files"}
        </span>
        {(totalAdditions > 0 || totalDeletions > 0) && (
          <span className="smartlog-churn">
            <span className="smartlog-churn-add">+{totalAdditions}</span>{" "}
            <span className="smartlog-churn-del">−{totalDeletions}</span>
          </span>
        )}
      </div>
      <div className="smartlog-file-list">
        {visibleFiles.map((file) => (
          <button
            key={file.path}
            type="button"
            className="smartlog-file-row"
            disabled={!onOpenFile || file.status === "D"}
            onClick={() => onOpenFile?.(file.path)}
            title={file.status === "D" ? `${file.path} (deleted)` : `Open ${file.path}`}
          >
            <span className="smartlog-file-status">{file.status}</span>
            <span className="smartlog-file-path">{file.path}</span>
            {(file.additions != null || file.deletions != null) && (
              <span className="smartlog-churn">
                <span className="smartlog-churn-add">+{file.additions ?? 0}</span>{" "}
                <span className="smartlog-churn-del">−{file.deletions ?? 0}</span>
              </span>
            )}
          </button>
        ))}
        {files.length > FILE_LIST_CAP && (
          <button
            type="button"
            className="smartlog-file-toggle"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show fewer" : `Show all ${files.length} files ▾`}
          </button>
        )}
      </div>
    </div>
  );
}

export function SmartLogView({
  status,
  loading,
  workspacePath,
  onRefresh,
  onOpenFile,
}: {
  status: SessionVcsStatus | null;
  loading: boolean;
  workspacePath: string | null;
  onRefresh: () => void;
  onOpenFile?: (path: string) => void;
}) {
  const nowMs = Date.now();
  if (!status && loading) {
    return (
      <div className="smartlog-pane">
        <p className="smartlog-empty">Loading smart log…</p>
      </div>
    );
  }
  if (!status || !status.isGitCheckout) {
    return (
      <div className="smartlog-pane">
        <p className="smartlog-empty">No git repository detected in this working directory.</p>
      </div>
    );
  }

  const visibleCommits = filterSmartlogForDisplay(status.smartlogCommits);
  const rows = computeSmartlogLayout(visibleCommits);
  const maxLanes = rows.reduce((max, row) => Math.max(max, row.totalLanes), 1);
  const isDirty = status.uncommittedFileCount > 0;

  return (
    <div className="smartlog-pane">
      <div className="file-tab-toolbar">
        <span title={workspacePath ?? status.branch ?? "Repository"}>
          {workspacePath ?? status.branch ?? "Repository"}
        </span>
        <div className="file-tab-actions">
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refresh Smart Log"
            title="Refresh"
          >
            <RefreshIcon />
          </button>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="smartlog-empty">No commits yet in this repository.</p>
      ) : (
        <div className="smartlog-graph">
          {rows.map((row) => {
            const { commit } = row;
            const isPublic = commit.phase === "public";
            const bookmarks = displaySmartlogBookmarks(commit);
            const age = commit.date ? formatRelativeTime(commit.date, nowMs) : "";
            const headPrefix = commit.isDot ? (
              <Fragment key={`${commit.hash}-here`}>
                <div className="smartlog-pill-row">
                  <SmartLogGraphRailPassThrough
                    capHeadLane
                    headLane={row.lane}
                    joins={row.joins}
                    laneState={row.laneState}
                    maxLanes={maxLanes}
                    splits={row.splits}
                  />
                  <span
                    className="smartlog-you-are-here"
                    style={{ left: `${Math.max(smartlogLaneCenterX(row.lane) - 8, 0)}px` }}
                  >
                    You are here
                  </span>
                </div>
                {isDirty && (
                  <div className="smartlog-commit-row">
                    <SmartLogGraphRailPassThrough
                      headLane={row.lane}
                      joins={row.joins}
                      laneState={row.laneState}
                      maxLanes={maxLanes}
                      splits={row.splits}
                    />
                    <SmartLogUncommittedBlock
                      files={status.files}
                      totalAdditions={status.totalAdditions}
                      totalDeletions={status.totalDeletions}
                      uncommittedFileCount={status.uncommittedFileCount}
                      onOpenFile={onOpenFile}
                    />
                  </div>
                )}
              </Fragment>
            ) : null;

            return (
              <Fragment key={commit.hash}>
                {headPrefix}
                <div className="smartlog-commit-row">
                  <SmartLogGraphRail
                    ancestorAbove={row.ancestorAbove}
                    ancestorBelow={row.ancestorBelow}
                    converges={row.converges}
                    isHead={commit.isDot}
                    joins={row.joins}
                    lane={row.lane}
                    laneState={row.laneState}
                    line={row.line}
                    maxLanes={maxLanes}
                    ownLaneBelow={row.ownLaneBelow}
                    splits={row.splits}
                  />
                  <div className={`smartlog-commit-body${commit.isDot ? " is-head" : ""}`}>
                    {isPublic ? (
                      <div className="smartlog-public-line">
                        {bookmarks.map((name) => (
                          <span key={name} className="smartlog-bookmark-tag" title={name}>
                            {name}
                          </span>
                        ))}
                        <span className="smartlog-commit-hash">{commit.hash.slice(0, 8)}</span>
                        <span className="smartlog-commit-title-inline" title={commit.title}>
                          {commit.title}
                        </span>
                        {age && <span className="smartlog-commit-age">{age}</span>}
                      </div>
                    ) : (
                      <>
                        <div className="smartlog-commit-line">
                          <span className="smartlog-commit-title" title={commit.title}>
                            {commit.title}
                          </span>
                        </div>
                        <div className="smartlog-commit-meta">
                          {bookmarks.map((name) => (
                            <span key={name} className="smartlog-bookmark-tag" title={name}>
                              {name}
                            </span>
                          ))}
                          <span className="smartlog-commit-hash">{commit.hash.slice(0, 8)}</span>
                          <span>·</span>
                          <span>{commit.author}</span>
                          {age && (
                            <>
                              <span>·</span>
                              <span>{age}</span>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
