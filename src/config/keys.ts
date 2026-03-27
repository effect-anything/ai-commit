import { ConfigError } from "../shared/errors.ts";

export const ScopeUser = "user";
export const ScopeProject = "project";
export const ScopeLocal = "local";

export type ConfigScope = typeof ScopeUser | typeof ScopeProject | typeof ScopeLocal;

interface KeyDef {
  readonly type: "string" | "bool" | "int" | "stringslice";
  readonly allowUser?: boolean | undefined;
  readonly allowProject?: boolean | undefined;
  readonly allowLocal?: boolean | undefined;
}

const keyRegistry: Record<string, KeyDef> = {
  api_key: { type: "string", allowUser: true },
  base_url: { type: "string", allowUser: true },
  model: { type: "string", allowUser: true },
  scopes: { type: "stringslice", allowProject: true, allowLocal: true },
  hook: { type: "stringslice", allowProject: true, allowLocal: true },
  max_diff_lines: { type: "int", allowProject: true, allowLocal: true },
  no_git_agent_co_author: { type: "bool", allowUser: true, allowProject: true, allowLocal: true },
  no_model_co_author: { type: "bool", allowUser: true, allowProject: true, allowLocal: true },
};

const keyAliases: Record<string, string> = {
  "api-key": "api_key",
  "base-url": "base_url",
  "max-diff-lines": "max_diff_lines",
  "no-git-agent-co-author": "no_git_agent_co_author",
  "no-model-co-author": "no_model_co_author",
};

export const resolveKey = (raw: string): string => {
  if (raw in keyRegistry) {
    return raw;
  }
  const aliased = keyAliases[raw];
  if (typeof aliased === "string") {
    return aliased;
  }
  throw new ConfigError({ message: `unknown config key "${raw}"` });
};

export const validateScope = (key: string, scope: ConfigScope): void => {
  const def = keyRegistry[key];
  if (def == null) {
    throw new ConfigError({ message: `unknown config key "${key}"` });
  }
  if (scope === ScopeUser && !def.allowUser) {
    throw new ConfigError({ message: `key "${key}" cannot be set in user scope` });
  }
  if (scope === ScopeProject && !def.allowProject) {
    throw new ConfigError({ message: `key "${key}" cannot be set in project scope` });
  }
  if (scope === ScopeLocal && !def.allowLocal) {
    throw new ConfigError({ message: `key "${key}" cannot be set in local scope` });
  }
};

export const defaultScopeForKey = (key: string): ConfigScope => {
  const def = keyRegistry[key];
  if (def?.allowUser === true && def.allowProject !== true && def.allowLocal !== true) {
    return ScopeUser;
  }
  return ScopeProject;
};

export const normalizeValue = (key: string, raw: string): string => {
  const def = keyRegistry[key];
  if (def == null) {
    throw new ConfigError({ message: `unknown config key "${key}"` });
  }
  if (raw.trim().length === 0) {
    throw new ConfigError({ message: `empty value for key "${key}"` });
  }

  switch (def.type) {
    case "bool":
      if (raw !== "true" && raw !== "false") {
        throw new ConfigError({
          message: `invalid boolean value "${raw}" for "${key}": must be true or false`,
        });
      }
      return raw;
    case "int":
      if (!/^-?\d+$/.test(raw)) {
        throw new ConfigError({ message: `invalid integer value "${raw}" for "${key}"` });
      }
      return String(Number(raw));
    case "stringslice": {
      const parts = raw
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      if (parts.length === 0) {
        throw new ConfigError({ message: `empty value for key "${key}"` });
      }
      return parts.join(",");
    }
    default:
      return raw;
  }
};

export const getKeyDef = (key: string): KeyDef | undefined => keyRegistry[key];
