export interface ProjectScope {
  readonly name: string;
  readonly description?: string;
}

export interface ProjectConfig {
  readonly scopes: ReadonlyArray<ProjectScope>;
  readonly hooks: ReadonlyArray<string>;
  readonly maxDiffLines: number;
  readonly noGitAgentCoAuthor: boolean;
  readonly noModelCoAuthor: boolean;
}

export const emptyProjectConfig = (): ProjectConfig => ({
  scopes: [],
  hooks: [],
  maxDiffLines: 0,
  noGitAgentCoAuthor: false,
  noModelCoAuthor: false,
});
