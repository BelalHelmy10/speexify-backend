import test from "node:test";
import assert from "node:assert/strict";
import {
  avatarFilenameFromUrl,
  resolveAvatarPath,
} from "../../src/lib/profileAvatarUpload.js";

test("avatar URLs only expose safe backend avatar filenames", () => {
  assert.equal(
    avatarFilenameFromUrl("/api/me/avatar/user-7-123.png"),
    "user-7-123.png",
  );
  assert.equal(avatarFilenameFromUrl("https://example.com/avatar.png"), "");
  assert.equal(avatarFilenameFromUrl("/api/me/avatar/../secret.txt"), "");
});

test("avatar path resolution rejects traversal", () => {
  assert.equal(resolveAvatarPath("../secret.txt"), null);
  assert.equal(resolveAvatarPath("nested/avatar.png"), null);
  assert.match(resolveAvatarPath("user-7-123.png"), /user-7-123\.png$/);
});
