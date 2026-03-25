import { wrapExplanation } from "../shared/text";

export interface ValidationIssue {
  readonly severity: "error" | "warning";
  readonly message: string;
}

export interface ValidationResult {
  readonly issues: ReadonlyArray<ValidationIssue>;
}

const headerRegex =
  /^(feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert)(\([a-z0-9_-]+\))?!?: .+/;
const coAuthorRegex = /^Co-Authored-By: .+ <[^>]+@[^>]+>$/;
const footerRegex = /^([A-Za-z][A-Za-z0-9-]*|BREAKING CHANGE): /;
const pastVerbs = new Set([
  "added",
  "removed",
  "updated",
  "changed",
  "fixed",
  "created",
  "deleted",
  "modified",
  "implemented",
  "refactored",
  "renamed",
  "moved",
  "replaced",
  "improved",
  "enhanced",
  "upgraded",
  "downgraded",
  "reverted",
  "resolved",
]);

export const validateConventional = (raw: string): ValidationResult => {
  const issues: Array<ValidationIssue> = [];
  if (raw.trim().length === 0) {
    return { issues: [{ severity: "error", message: "commit message is empty" }] };
  }

  const lines = raw.split("\n");
  const header = lines[0] ?? "";

  if (!headerRegex.test(header)) {
    issues.push({
      severity: "error",
      message:
        "header must match: <type>[(<scope>)][!]: <description> (valid types: feat fix docs style refactor perf test chore build ci revert)",
    });
  }
  if (header.length > 50) {
    issues.push({
      severity: "error",
      message: `title must be 50 characters or less (got ${header.length})`,
    });
  }
  if (header.endsWith(".")) {
    issues.push({
      severity: "error",
      message: "title must not end with a period",
    });
  }

  const separatorIndex = header.indexOf(": ");
  if (separatorIndex >= 0) {
    const description = header.slice(separatorIndex + 2);
    if (description !== description.toLowerCase()) {
      issues.push({
        severity: "error",
        message: "description must be all lowercase",
      });
    }
    const firstWord = description.trim().split(/\s+/)[0] ?? "";
    if (pastVerbs.has(firstWord)) {
      issues.push({
        severity: "warning",
        message: `description starts with past-tense verb "${firstWord}" - prefer imperative mood`,
      });
    }
  }

  if (lines.length < 3) {
    issues.push({
      severity: "error",
      message: "body is required: add bullet points followed by an explanation paragraph",
    });
    return { issues };
  }
  if ((lines[1] ?? "") !== "") {
    issues.push({
      severity: "error",
      message: "blank line required between header and body",
    });
  }

  const bodyLines = lines.slice(2);
  let lastBulletIndex = -1;
  const bulletFirstWords: Array<string> = [];

  for (const [index, line] of bodyLines.entries()) {
    if (line.startsWith("- ")) {
      lastBulletIndex = index;
      const firstWord = line.slice(2).trim().split(/\s+/)[0] ?? "";
      if (firstWord.length > 0) {
        bulletFirstWords.push(firstWord.toLowerCase());
      }
    }
  }

  if (lastBulletIndex === -1) {
    issues.push({
      severity: "error",
      message: "body must contain at least one bullet point starting with '- '",
    });
  } else {
    const hasExplanation = bodyLines.slice(lastBulletIndex + 1).some((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !footerRegex.test(trimmed) && !trimmed.startsWith("- ");
    });
    if (!hasExplanation) {
      issues.push({
        severity: "error",
        message: "explanation paragraph required after bullet points",
      });
    }
  }

  for (const line of bodyLines) {
    if (footerRegex.test(line)) {
      continue;
    }
    if (line.length > 72) {
      issues.push({
        severity: "error",
        message: `body line exceeds 72 characters: ${line}`,
      });
    }
    if (line.startsWith("Co-Authored-By: ") && !coAuthorRegex.test(line)) {
      issues.push({
        severity: "error",
        message: "Co-Authored-By footer must match 'Co-Authored-By: Name <email@example.com>'",
      });
    }
  }

  for (const word of bulletFirstWords) {
    if (pastVerbs.has(word)) {
      issues.push({
        severity: "warning",
        message: `bullet starts with past-tense verb "${word}" - prefer imperative mood`,
      });
    }
  }

  return {
    issues,
  };
};

export const hasErrors = (result: ValidationResult): boolean =>
  result.issues.some((issue) => issue.severity === "error");

export const validationErrors = (result: ValidationResult): Array<string> =>
  result.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message);

export const validationWarnings = (result: ValidationResult): Array<string> =>
  result.issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message);

export const normalizeExplanation = (text: string): string => wrapExplanation(text, 72);
