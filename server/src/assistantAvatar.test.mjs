import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAssistantAvatar } from "./assistantAvatar.mjs";
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz/8AAAAASUVORK5CYII=";
const jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD0uiiivEPRP//Z";
const webp = "data:image/webp;base64,UklGRjYAAABXRUJQVlA4ICoAAACwAQCdASoCAAIAAUAmJZgCdLoABDAAAP739H/9i3s9gd4/2pRBSVsAAAA=";

test("assistant avatar accepts static PNG, JPEG and WebP", () => {
  for (const image of [png, jpeg, webp]) assert.equal(validateAssistantAvatar(image), null);
});

test("assistant avatar rejects remote, active, malformed and oversized images without throwing", () => {
  for (const image of [null, {}, "https://example.com/avatar.png", "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
    "data:image/png;base64,A", "data:image/png;base64,====", png.replace("image/png", "image/jpeg"),
    "data:image/png;base64," + Buffer.alloc(256*1024+1).toString("base64")]) {
    assert.equal(typeof validateAssistantAvatar(image), "string", String(image));
  }
});

test("avatar dimensions are bounded and animated PNG is refused", () => {
  const bytes = Buffer.from(png.split(",")[1], "base64");
  bytes.writeUInt32BE(513, 16);
  assert.ok(validateAssistantAvatar("data:image/png;base64,"+bytes.toString("base64")));
  bytes.writeUInt32BE(1, 16);
  const chunk = Buffer.alloc(20); chunk.writeUInt32BE(8, 0); chunk.write("acTL", 4); chunk.writeUInt32BE(2, 8);
  const animated = Buffer.concat([bytes.subarray(0,33),chunk,bytes.subarray(33)]);
  assert.ok(validateAssistantAvatar("data:image/png;base64,"+animated.toString("base64")));
});

test("a WebP container without an image cannot pass as an avatar", () => {
  const container = Buffer.alloc(20);container.write("RIFF");container.writeUInt32LE(12,4);container.write("WEBPJUNK",8);
  assert.ok(validateAssistantAvatar("data:image/webp;base64,"+container.toString("base64")));
});
