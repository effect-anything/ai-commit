import type { ProgressAttributeDescriptor, ProgressRenderConfig } from "./tracing";

const hiddenAttributePrefixes = ["http.request.header.", "http.response.header."];

const hiddenInteractiveAttributeKeys = new Set([
  "concurrency",
  "gen_ai.openai.request.response_format",
  "gen_ai.openai.response.service_tier",
  "gen_ai.operation.name",
  "gen_ai.response.id",
  "gen_ai.system",
  "server.port",
  "url.full",
]);

const orderedInteractiveAttributeKeys = [
  "vcs",
  "requested_vcs",
  "dry_run",
  "no_stage",
  "amend",
  "step",
  "reason",
  "full_wizard",
  "hook_count",
  "max_commits",
  "staged_files",
  "unstaged_files",
  "file_count",
  "http.request.method",
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
  "gen_ai.request.model": "model",
  "gen_ai.response.model": "model",
  "http.request.method": "method",
  "http.response.status_code": "status",
  "server.address": "server",
  "url.path": "path",
};

const toInteractiveDescriptors = (
  attributes: ReadonlyMap<string, unknown>,
): Array<ProgressAttributeDescriptor> => {
  const descriptors: Array<ProgressAttributeDescriptor> = [];
  const used = new Set<string>();

  const push = (
    key: string,
    value: unknown,
    label = interactiveLabelByKey[key] ?? key,
    dedupeKey?: string,
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
      if (hiddenInteractiveAttributeKeys.has(key)) {
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
  formatAttributes({ attributes }, { mode }) {
    if (mode === "raw") {
      return undefined;
    }
    return toInteractiveDescriptors(attributes);
  },
};
