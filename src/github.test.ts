import { describe, expect, test } from "bun:test";
import { eventKey, extractContext, verifySignature } from "./github.ts";
import { renderTemplate } from "./template.ts";

const reviewRequested = {
  action: "review_requested",
  repository: { full_name: "acme/widgets", html_url: "https://github.com/acme/widgets", default_branch: "main" },
  sender: { login: "alice" },
  requested_reviewer: { login: "bernardo" },
  pull_request: {
    number: 42,
    title: "Add widgets",
    html_url: "https://github.com/acme/widgets/pull/42",
    body: "Adds widgets.",
    user: { login: "alice" },
    head: { ref: "feat/widgets", sha: "abc123" },
    base: { ref: "main" },
  },
};

describe("verifySignature", () => {
  const body = JSON.stringify(reviewRequested);
  const secret = "s3cret";
  const good = "sha256=" + new Bun.CryptoHasher("sha256", secret).update(body).digest("hex");

  test("accepts the matching HMAC", () => {
    expect(verifySignature(secret, body, good)).toBe(true);
  });

  test("rejects a wrong secret, tampered body, or missing header", () => {
    expect(verifySignature("other", body, good)).toBe(false);
    expect(verifySignature(secret, body + " ", good)).toBe(false);
    expect(verifySignature(secret, body, null)).toBe(false);
    expect(verifySignature(secret, body, "sha1=abc")).toBe(false);
  });
});

describe("eventKey", () => {
  test("joins event and action, or falls back to the event alone", () => {
    expect(eventKey("pull_request", reviewRequested)).toBe("pull_request.review_requested");
    expect(eventKey("push", { ref: "refs/heads/main" })).toBe("push");
  });
});

describe("extractContext", () => {
  test("flattens a pull request payload", () => {
    const ctx = extractContext("pull_request", reviewRequested);
    expect(ctx).toMatchObject({
      repo: "acme/widgets",
      event: "pull_request",
      action: "review_requested",
      requested_reviewer: "bernardo",
      pr_number: "42",
      pr_title: "Add widgets",
      pr_url: "https://github.com/acme/widgets/pull/42",
      pr_head: "feat/widgets",
      pr_base: "main",
      pr_author: "alice",
      sender: "alice",
    });
    expect(ctx.issue_number).toBeUndefined();
  });

  test("treats a comment on a PR as a PR event too", () => {
    const ctx = extractContext("issue_comment", {
      action: "created",
      repository: { full_name: "acme/widgets" },
      issue: { number: 7, title: "Fix it", html_url: "https://github.com/acme/widgets/pull/7", user: { login: "bob" }, pull_request: { html_url: "https://github.com/acme/widgets/pull/7" } },
      comment: { body: "@t3 review", user: { login: "carol" }, html_url: "https://github.com/acme/widgets/pull/7#issuecomment-1" },
    });
    expect(ctx.pr_number).toBe("7");
    expect(ctx.issue_number).toBe("7");
    expect(ctx.comment_body).toBe("@t3 review");
    expect(ctx.comment_author).toBe("carol");
  });

  test("uses the team slug when a team is requested", () => {
    const ctx = extractContext("pull_request", { ...reviewRequested, requested_reviewer: undefined, requested_team: { slug: "platform" } });
    expect(ctx.requested_reviewer).toBe("platform");
  });
});

describe("renderTemplate", () => {
  test("substitutes known variables and blanks unknown ones", () => {
    const out = renderTemplate("Review {{pr_url}} ({{ pr_head }}) {{missing}}!", { pr_url: "u", pr_head: "h" });
    expect(out).toBe("Review u (h) !");
  });
});
