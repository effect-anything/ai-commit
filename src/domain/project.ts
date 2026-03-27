import { Schema, SchemaTransformation } from "effect";

const TrimmedString = Schema.String.pipe(Schema.decode(SchemaTransformation.trim()));
const NonEmptyTrimmedString = TrimmedString.check(Schema.isNonEmpty());

export class ProjectScope extends Schema.Class<ProjectScope>("ProjectScope")({
  name: NonEmptyTrimmedString,
  description: Schema.optionalKey(NonEmptyTrimmedString),
}) {}

export const ProjectConfig = Schema.Struct({
  scopes: Schema.Array(ProjectScope),
  hooks: Schema.Array(NonEmptyTrimmedString),
  maxDiffLines: Schema.Int,
  noGitAgentCoAuthor: Schema.Boolean,
  noModelCoAuthor: Schema.Boolean,
});

export type ProjectConfig = typeof ProjectConfig.Type;

export const emptyProjectConfig = (): ProjectConfig => ({
  scopes: [],
  hooks: [],
  maxDiffLines: 0,
  noGitAgentCoAuthor: false,
  noModelCoAuthor: false,
});
