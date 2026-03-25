import type { Trailer } from "../domain/commit";

export const countLines = (content: string): number => {
  if (content.length === 0) {
    return 0;
  }
  return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
};

export const wrapLongLine = (line: string, width: number): Array<string> => {
  const parts: Array<string> = [];
  let remaining = line;

  while (remaining.length > width) {
    const slice = remaining.slice(0, width + 1);
    const lastSpace = slice.lastIndexOf(" ");
    if (lastSpace <= 0) {
      parts.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
      continue;
    }
    parts.push(remaining.slice(0, lastSpace));
    remaining = remaining.slice(lastSpace + 1);
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }

  return parts;
};

export const wrapExplanation = (text: string, width = 72): string =>
  text
    .split("\n")
    .flatMap((line) => (line.length <= width ? [line] : wrapLongLine(line, width)))
    .join("\n");

export const extractJson = (input: string): string => {
  const candidates: Array<[string, string]> = [
    ["{", "}"],
    ["[", "]"],
  ];
  let start = -1;
  let open = "";
  let close = "";

  for (const [candidateOpen, candidateClose] of candidates) {
    const index = input.indexOf(candidateOpen);
    if (index !== -1 && (start === -1 || index < start)) {
      start = index;
      open = candidateOpen;
      close = candidateClose;
    }
  }

  if (start === -1) {
    return input;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === open) {
      depth += 1;
      continue;
    }
    if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return input.slice(start, index + 1);
      }
    }
  }

  return input;
};

export const appendTrailers = (message: string, trailers: ReadonlyArray<Trailer>): string => {
  if (trailers.length === 0) {
    return message.trimEnd();
  }
  const footer = trailers.map((trailer) => `${trailer.key}: ${trailer.value}`).join("\n");
  return `${message.trimEnd()}\n\n${footer}`;
};

export const parseCsv = (input: string | undefined): Array<string> =>
  (input ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

export const parseCsvValues = (inputs: ReadonlyArray<string>): Array<string> =>
  inputs.flatMap((input) => parseCsv(input));
