import { Schema } from "effect";

const ProviderConfigSchema = Schema.Struct({
  apiKey: Schema.String,
  baseUrl: Schema.String,
  model: Schema.String,
  noCommitCoAuthor: Schema.Boolean,
  noModelCoAuthor: Schema.Boolean,
});

export type ProviderConfig = typeof ProviderConfigSchema.Type;

export interface ProviderConfigInput {
  readonly cwd: string;
  readonly apiKey: string | undefined;
  readonly baseUrl: string | undefined;
  readonly model: string | undefined;
  readonly vcs: "git" | "jj" | undefined;
}
