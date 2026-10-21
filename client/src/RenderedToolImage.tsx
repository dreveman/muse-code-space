import { memo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { ImagePreview } from "./toolPresentation";

// Thumbnail for a completed read of a binary image, mirroring how Markdown
// replies show workspace images (show-image): the bytes are loaded from the
// session workspace via readSessionImage, never from the tool output itself.
// Clicking opens the current on-disk image in the image viewer tab.
export const ToolImageView = memo(function ToolImageView({ sessionId, preview, workspaceRoot, onOpenFile }: { sessionId: string; preview: ImagePreview; workspaceRoot: string; onOpenFile?: (path: string) => void }) {
  const candidate = preview.path.startsWith(`${workspaceRoot}/`) ? preview.path.slice(workspaceRoot.length + 1) : preview.path;
  const relative = candidate && !candidate.startsWith("/") && !candidate.includes("\\") &&
    !candidate.split("/").includes("..") && !/[\x00-\x1f\x7f]/.test(candidate) ? candidate : null;
  const imageQuery = useQuery({
    queryKey: ["session-image", sessionId, relative],
    queryFn: () => api.readSessionImage({ session_id: sessionId, path: relative! }),
    enabled: Boolean(relative),
    staleTime: Infinity,
    retry: false,
  });
  const name = preview.path.split("/").at(-1) || preview.path;
  if (!relative) {
    return <span className="markdown-image-placeholder">{name} (image preview unavailable)</span>;
  }
  if (imageQuery.isPending) {
    return <span className="markdown-image-placeholder">Loading image {relative}…</span>;
  }
  if (!imageQuery.data?.ok || !imageQuery.data.media_type || !imageQuery.data.base64_data) {
    return <span className="markdown-image-placeholder">{name} (image could not be loaded)</span>;
  }
  const src = `data:${imageQuery.data.media_type};base64,${imageQuery.data.base64_data}`;
  const img = <img className="markdown-inline-image tool-image-thumbnail" src={src} alt={name} loading="lazy" />;
  if (!onOpenFile) return img;
  return (
    <button
      type="button"
      className="markdown-image-button"
      title={`Open ${relative} in image viewer`}
      onClick={() => onOpenFile(relative)}
    >
      {img}
    </button>
  );
});
