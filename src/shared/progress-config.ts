import type { ProgressAttributeDescriptor, ProgressRenderConfig } from "./tracing.ts";

const hiddenAttributePrefixes = ["http.request.header.", "http.response.header."];

const hiddenAttributeKeys = new Set([
  "concurrency",
  "gen_ai.openai.request.response_format",
  "gen_ai.openai.response.service_tier",
  "gen_ai.operation.name",
  "gen_ai.response.id",
  "gen_ai.system",
  "http.request.method",
  "server.port",
  "toolChoice",
  "url.full",
  "url.scheme",
]);

const orderedInteractiveAttributeKeys = [
  "vcs",
  "dry_run",
  "no_stage",
  "amend",
  "step",
  "retry_attempt",
  "retry_delay",
  "retry_at",
  "reason",
  "full_wizard",
  "hook_count",
  "max_commits",
  "staged_files",
  "unstaged_files",
  "file_count",
  "url.path",
  "http.response.status_code",
  "server.address",
  "gen_ai.request.model",
  "gen_ai.response.model",
] as const;

const interactiveLabelByKey: Record<string, string> = {
  file_count: "files",
  hook_count: "hooks",
  max_commits: "commits",
  staged_files: "staged",
  unstaged_files: "unstaged",
  retry_attempt: "retry",
  retry_delay: "in",
  retry_at: "at",
  "gen_ai.request.model": "model",
  "gen_ai.response.model": "model",
  "http.response.status_code": "status",
  "server.address": "server",
  "url.path": "path",
};

const friendlySpanNames: Record<string, string> = {
  "Commit.ScanChanges": "Scan changes",
  "Commit.PlanGroups": "Plan commits",
  "Commit.ResolveMessage": "Resolve commit message",
  "Commit.ReplanGroups": "Replan commits",
  "Commit.Create": "Create commit",
  "Commit.create": "Create commit",
  "Commit.LoadPrevious": "Load previous commit",
  "Commit.Amend": "Amend commit",
  "Config.GenerateGitignore": "Generate .gitignore",
  "Config.GenerateScopes": "Generate scopes",
  "Config.ResolveProvider": "Resolve provider",
  "Init.WriteDefaultHook": "Write default hook",
  "Init.WriteHook": "Write hook config",
  "LLM.GenerateMessage": "Generate commit message",
  "LLM.PlanCommits": "Plan commits",
  "LanguageModel.generateText": "Call model",
};

const titleCase = (value: string): string =>
  value
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");

const formatFriendlySpanName = (name: string, attributes: ReadonlyMap<string, unknown>): string => {
  const friendly = friendlySpanNames[name];
  if (friendly != null) {
    if (name === "hooks.execute") {
      const hookType = attributes.get("hook_type");
      return hookType === "conventional" ? "Validate conventional commit" : friendly;
    }
    return friendly;
  }

  if (name.startsWith("http.client")) {
    const method = attributes.get("http.request.method");
    return typeof method === "string" && method.length > 0 ? `HTTP ${method}` : "HTTP request";
  }

  return titleCase(name.replace(/[._-]+/g, " "));
};

const simplifyInteractiveLabel = (key: string): string => {
  const mapped = interactiveLabelByKey[key];
  if (mapped != null) {
    return mapped;
  }
  if (key.startsWith("gen_ai.request.")) {
    return key.slice("gen_ai.request.".length);
  }
  if (key.startsWith("gen_ai.response.")) {
    return key.slice("gen_ai.response.".length);
  }
  if (key.startsWith("gen_ai.usage.")) {
    return key.slice("gen_ai.usage.".length);
  }
  if (key.startsWith("gen_ai.")) {
    return key.slice("gen_ai.".length);
  }
  return key;
};

const toDescriptors = (
  attributes: ReadonlyMap<string, unknown>,
): Array<ProgressAttributeDescriptor> => {
  const descriptors: Array<ProgressAttributeDescriptor> = [];
  const used = new Set<string>();

  const push = (
    key: string,
    value: unknown,
    label = simplifyInteractiveLabel(key),
    dedupeKey?: string | undefined,
  ) => {
    if (value === undefined || value === null) {
      return;
    }
    used.add(key);
    descriptors.push(
      dedupeKey == null
        ? {
            key,
            label,
            value,
          }
        : {
            key,
            label,
            value,
            dedupeKey,
          },
    );
  };

  const groupIndex = attributes.get("group_index");
  const groupTotal = attributes.get("group_total");
  if (groupIndex !== undefined && groupTotal !== undefined) {
    used.add("group_index");
    used.add("group_total");
    descriptors.push({
      key: "group_index",
      label: "group",
      value: `${groupIndex}/${groupTotal}`,
      dedupeKey: `group=${groupIndex}/${groupTotal}`,
    });
  }

  const inputTokens = attributes.get("gen_ai.usage.input_tokens");
  const outputTokens = attributes.get("gen_ai.usage.output_tokens");
  if (inputTokens !== undefined || outputTokens !== undefined) {
    used.add("gen_ai.usage.input_tokens");
    used.add("gen_ai.usage.output_tokens");
    descriptors.push({
      key: "gen_ai.usage.input_tokens",
      label: "tokens",
      value: `${inputTokens ?? 0}/${outputTokens ?? 0}`,
      dedupeKey: `tokens=${inputTokens ?? 0}/${outputTokens ?? 0}`,
    });
  }

  for (const key of orderedInteractiveAttributeKeys) {
    if (used.has(key) || !attributes.has(key)) {
      continue;
    }
    push(key, attributes.get(key));
  }

  const remaining = [...attributes.entries()]
    .filter(([key, value]) => {
      if (used.has(key) || value === undefined || value === null) {
        return false;
      }
      if (hiddenAttributeKeys.has(key)) {
        return false;
      }
      return hiddenAttributePrefixes.every((prefix) => !key.startsWith(prefix));
    })
    .sort(([left], [right]) => left.localeCompare(right));

  for (const [key, value] of remaining) {
    push(key, value);
  }

  return descriptors;
};

export const gitAgentProgressRenderConfig: ProgressRenderConfig = {
  headerLabel: "Git agent",
  formatSpanName(name, { span }) {
    return formatFriendlySpanName(name, span.attributes);
  },
  formatAttributes({ attributes }) {
    return toDescriptors(attributes);
  },
};
