export interface Trailer {
  readonly key: string;
  readonly value: string;
}

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

export interface CommitMessage {
  readonly title: string;
  readonly bullets: ReadonlyArray<string>;
  readonly explanation: string;
}

export interface CommitGroup {
  readonly files: ReadonlyArray<string>;
  readonly message: CommitMessage | undefined;
}

export interface CommitPlan {
  readonly groups: ReadonlyArray<CommitGroup>;
}

export interface SingleCommitResult {
  readonly title: string;
  readonly explanation: string;
  readonly files: ReadonlyArray<string>;
  readonly output: string | undefined;
}

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
