import { Schema } from "effect";

export const Trailer = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
});

export type Trailer = typeof Trailer.Type;

export const parseTrailerText = (input: string): Trailer | undefined => {
  const separator = ": ";
  const index = input.indexOf(separator);
  if (index <= 0) {
    return undefined;
  }

  const key = input.slice(0, index).trim();
  const value = input.slice(index + separator.length).trim();
  if (key.length === 0 || value.length === 0) {
    return undefined;
  }

  return {
    key,
    value,
  };
};

export const CommitMessage = Schema.Struct({
  title: Schema.String,
  bullets: Schema.Array(Schema.String),
  explanation: Schema.String,
});

export type CommitMessage = typeof CommitMessage.Type;

export const CommitGroup = Schema.Struct({
  files: Schema.Array(Schema.String),
  message: CommitMessage.pipe(Schema.UndefinedOr),
});

export type CommitGroup = typeof CommitGroup.Type;

export const SingleCommitResult = Schema.Struct({
  title: Schema.String,
  bullets: Schema.Array(Schema.String),
  explanation: Schema.String,
  files: Schema.Array(Schema.String),
  output: Schema.String.pipe(Schema.UndefinedOr),
});

export type SingleCommitResult = typeof SingleCommitResult.Type;

export const CommitResponse = Schema.Array(SingleCommitResult);

export type CommitResponse = typeof CommitResponse.Type;

export const renderCommitBody = (message: CommitMessage): string => {
  const bulletSection = message.bullets.map((bullet) => `- ${bullet}`).join("\n");
  if (bulletSection.length === 0 && message.explanation.length === 0) {
    return "";
  }

  if (bulletSection.length === 0) {
    return message.explanation;
  }

  if (message.explanation.length === 0) {
    return bulletSection;
  }

  return `${bulletSection}\n\n${message.explanation}`;
};
