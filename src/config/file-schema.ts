import { Schema, SchemaTransformation } from "effect";
import { ProjectScope } from "../domain/project.ts";

const TrimmedString = Schema.String.pipe(Schema.decode(SchemaTransformation.trim()));
const NonEmptyTrimmedString = TrimmedString.check(Schema.isNonEmpty());

const SchemaReferenceField = Schema.optionalKey(Schema.String.pipe(Schema.UndefinedOr));

export const UserConfigSchemaFileName = "schemas/user-config.schema.json";
export const ProjectConfigSchemaFileName = "schemas/project-config.schema.json";

export const UserConfigFileSchema = Schema.Struct({
  $schema: SchemaReferenceField,
  api_key: Schema.optionalKey(Schema.String.pipe(Schema.UndefinedOr)),
  base_url: Schema.optionalKey(Schema.String.pipe(Schema.UndefinedOr)),
  model: Schema.optionalKey(Schema.String.pipe(Schema.UndefinedOr)),
  no_commit_co_author: Schema.optionalKey(Schema.Boolean.pipe(Schema.UndefinedOr)),
  no_model_co_author: Schema.optionalKey(Schema.Boolean.pipe(Schema.UndefinedOr)),
});

export type UserConfigFile = typeof UserConfigFileSchema.Type;

export const ProjectConfigFileSchema = Schema.Struct({
  $schema: SchemaReferenceField,
  scopes: Schema.optionalKey(Schema.Array(ProjectScope).pipe(Schema.UndefinedOr)),
  hook: Schema.optionalKey(Schema.Array(NonEmptyTrimmedString).pipe(Schema.UndefinedOr)),
  max_diff_lines: Schema.optionalKey(Schema.Int.pipe(Schema.UndefinedOr)),
  no_commit_co_author: Schema.optionalKey(Schema.Boolean.pipe(Schema.UndefinedOr)),
  no_model_co_author: Schema.optionalKey(Schema.Boolean.pipe(Schema.UndefinedOr)),
});

export type ProjectConfigFile = typeof ProjectConfigFileSchema.Type;

const toJsonSchema = <S extends Schema.Top>(schema: S, title: string) => {
  const base = Schema.toStandardJSONSchemaV1(schema)["~standard"].jsonSchema.input({
    target: "draft-07",
  });
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title,
    ...base,
  };
};

export const userConfigJsonSchema = () =>
  toJsonSchema(UserConfigFileSchema, "ai-commit user config");

export const projectConfigJsonSchema = () =>
  toJsonSchema(ProjectConfigFileSchema, "ai-commit project config");
