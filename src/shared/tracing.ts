import { clearScreenDown, cursorTo, moveCursor } from "node:readline";
import { Cause, Duration, Effect, Exit, Layer, Schema, ServiceMap, Tracer } from "effect";
import { renderError } from "./errors.ts";

type ProgressStatus = "running" | "done" | "failed" | "interrupted";

interface ProgressNode {
  readonly spanId: string;
  readonly parentId: string | undefined;
  readonly name: string;
  readonly span: Tracer.Span;
  readonly children: Array<string>;
  readonly depth: number;
  status: ProgressStatus;
  startedAt: bigint;
  endedAt: bigint | undefined;
  order: number;
  failureSummary: string | undefined;
}

interface ProgressLoggerService {
  readonly start: (span: Tracer.Span, startTime: bigint) => void;
  readonly end: (span: Tracer.Span, endTime: bigint, exit: Exit.Exit<unknown, unknown>) => void;
  readonly close: () => void;
}

interface CompactAttributeToken {
  readonly key: string;
  readonly label: string;
  readonly value: unknown;
  readonly rendered: string;
  readonly compareKey: string;
}

export type ProgressRenderMode = "interactive" | "raw";

export const ProgressAttributeDescriptor = Schema.Struct({
  key: Schema.String,
  label: Schema.optionalKey(Schema.String),
  value: Schema.Unknown,
  dedupeKey: Schema.optionalKey(Schema.String),
});

export type ProgressAttributeDescriptor = typeof ProgressAttributeDescriptor.Type;

export const ProgressAttributeFormatInput = Schema.Struct({
  key: Schema.String,
  value: Schema.Unknown,
  defaultLabel: Schema.String,
});

export type ProgressAttributeFormatInput = typeof ProgressAttributeFormatInput.Type;

export const ProgressAttributeFormatOutput = Schema.Struct({
  label: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.Unknown),
  dedupeKey: Schema.optionalKey(Schema.String),
});

export type ProgressAttributeFormatOutput = typeof ProgressAttributeFormatOutput.Type;

export const ProgressStatusSymbols = Schema.Struct({
  runningParent: Schema.String,
  success: Schema.String,
  failed: Schema.String,
  interrupted: Schema.String,
});

export type ProgressStatusSymbols = typeof ProgressStatusSymbols.Type;

export interface ProgressRenderConfig {
  readonly headerLabel?: string | undefined;
  readonly spinnerFrames?: ReadonlyArray<string> | undefined;
  readonly symbols?: Partial<ProgressStatusSymbols> | undefined;
  readonly formatSpanName?:
    | ((
        name: string,
        options: {
          readonly mode: ProgressRenderMode;
          readonly span: Tracer.Span;
        },
      ) => string)
    | undefined;
  readonly formatAttributes?:
    | ((
        input: {
          readonly attributes: ReadonlyMap<string, unknown>;
        },
        options: {
          readonly mode: ProgressRenderMode;
          readonly span: Tracer.Span;
        },
      ) => ReadonlyArray<ProgressAttributeDescriptor> | undefined)
    | undefined;
  readonly formatAttribute?:
    | ((
        attribute: ProgressAttributeFormatInput,
        options: {
          readonly mode: ProgressRenderMode;
          readonly span: Tracer.Span;
        },
      ) => ProgressAttributeFormatOutput | undefined)
    | undefined;
}

const defaultHeaderLabel = "progress";
const defaultSpinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const defaultStatusSymbols: ProgressStatusSymbols = {
  runningParent: "▸",
  success: "✓",
  failed: "✕",
  interrupted: "⊘",
};
const renderIntervalMs = 80;
const plainIndent = "  ";

const ansi = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  hideCursor: "\u001b[?25l",
  showCursor: "\u001b[?25h",
};

const tree = {
  branch: "├─ ",
  lastBranch: "└─ ",
  vertical: "│  ",
  space: "   ",
};
const detailPrefix = "↳ ";

export const defaultProgressRenderConfig: ProgressRenderConfig = {};

const formatDurationCompact = (nanos: bigint): string => {
  const millis = Number(nanos) / 1e6;
  if (!Number.isFinite(millis) || millis < 1) {
    return "<1ms";
  }
  if (millis < 1000) {
    return `${Math.round(millis)}ms`;
  }
  const seconds = millis / 1000;
  if (seconds < 60) {
    return `${seconds < 10 ? seconds.toFixed(1) : seconds.toFixed(0)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds < 10 ? remainingSeconds.toFixed(1) : remainingSeconds.toFixed(0)}s`;
};

const formatDurationVerbose = (nanos: bigint): string =>
  Duration.format(Duration.nanos(nanos)).replace(/\s+\d+ns$/, "");

const maybeColor = (enabled: boolean, color: string, value: string): string =>
  enabled ? `${color}${value}${ansi.reset}` : value;

const formatInteractiveValue = (value: unknown): string => {
  if (typeof value === "string") {
    const shortened = value.length > 60 ? `${value.slice(0, 57)}...` : value;
    return /^[A-Za-z0-9._:/@-]+$/.test(shortened) ? shortened : JSON.stringify(shortened);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
};

const formatRawValue = (value: unknown): string => {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
};

const formatSpanDisplayName = (
  name: string,
  span: Tracer.Span,
  config: ProgressRenderConfig,
  mode: ProgressRenderMode,
): string => config.formatSpanName?.(name, { mode, span }) ?? name;

const defaultAttributeDescriptors = (
  attributes: ReadonlyMap<string, unknown>,
): Array<ProgressAttributeDescriptor> =>
  [...attributes.entries()]
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({
      key,
      label: key,
      value,
    }));

const resolveAttributeDescriptors = (
  attributes: ReadonlyMap<string, unknown>,
  span: Tracer.Span,
  config: ProgressRenderConfig,
  mode: ProgressRenderMode,
): Array<ProgressAttributeDescriptor> => [
  ...(config.formatAttributes?.(
    {
      attributes,
    },
    { mode, span },
  ) ?? defaultAttributeDescriptors(attributes)),
];

const applyAttributeFormatter = (
  entry: ProgressAttributeDescriptor,
  span: Tracer.Span,
  config: ProgressRenderConfig,
  mode: ProgressRenderMode,
): CompactAttributeToken | undefined => {
  const defaultLabel = entry.label ?? entry.key;
  const formatted = config.formatAttribute?.(
    {
      key: entry.key,
      value: entry.value,
      defaultLabel,
    },
    { mode, span },
  );

  if (formatted === undefined && config.formatAttribute != null) {
    return undefined;
  }

  const label = formatted?.label ?? defaultLabel;
  const value = formatted?.value ?? entry.value;
  if (value === undefined || value === null) {
    return undefined;
  }
  const renderedValue = mode === "raw" ? formatRawValue(value) : formatInteractiveValue(value);
  return {
    key: entry.key,
    label,
    value,
    rendered: `${label}=${renderedValue}`,
    compareKey: formatted?.dedupeKey ?? entry.dedupeKey ?? `${label}=${renderedValue}`,
  };
};

const collectCompactAttributes = (
  attributes: ReadonlyMap<string, unknown>,
  span: Tracer.Span,
  config: ProgressRenderConfig,
): Array<CompactAttributeToken> => {
  const seen = new Set<string>();
  const tokens: Array<CompactAttributeToken> = [];
  for (const entry of resolveAttributeDescriptors(attributes, span, config, "interactive")) {
    const token = applyAttributeFormatter(entry, span, config, "interactive");
    if (token == null) {
      continue;
    }
    if (seen.has(token.compareKey)) {
      continue;
    }
    seen.add(token.compareKey);
    tokens.push(token);
  }

  return tokens;
};

const renderCompactAttributes = (
  attributes: ReadonlyMap<string, unknown>,
  span: Tracer.Span,
  config: ProgressRenderConfig,
  inherited = new Set<string>(),
): {
  readonly text: string;
  readonly visible: Set<string>;
} => {
  const tokens = collectCompactAttributes(attributes, span, config);
  const visible = new Set<string>();
  const rendered = tokens
    .filter((token) => !inherited.has(token.compareKey))
    .map((token) => {
      visible.add(token.compareKey);
      return token.rendered;
    });

  return {
    text: rendered.length === 0 ? "" : ` ${rendered.join(" ")}`,
    visible,
  };
};

const renderRawAttributesWithConfig = (
  attributes: ReadonlyMap<string, unknown>,
  span: Tracer.Span,
  config: ProgressRenderConfig,
): string => {
  const seen = new Set<string>();
  const rendered = resolveAttributeDescriptors(attributes, span, config, "raw").flatMap((entry) => {
    const token = applyAttributeFormatter(entry, span, config, "raw");
    if (token == null || seen.has(token.compareKey)) {
      return [];
    }
    seen.add(token.compareKey);
    return [token.rendered];
  });

  return rendered.length === 0 ? "" : ` ${rendered.join(" ")}`;
};

const toParentId = (span: Tracer.Span): string | undefined =>
  span.parent == null ? undefined : span.parent.spanId;

const isPureInterrupt = (exit: Exit.Exit<unknown, unknown>): boolean => {
  if (!Exit.isFailure(exit)) {
    return false;
  }
  const hasFailure = exit.cause.reasons.some(
    (reason) => Cause.isFailReason(reason) || Cause.isDieReason(reason),
  );
  return !hasFailure && Exit.hasInterrupts(exit);
};

const summarizeCause = (cause: Cause.Cause<unknown>): string | undefined => {
  const failure = cause.reasons.find(Cause.isFailReason);
  if (failure != null) {
    const rendered = renderError(failure.error).trim();
    if (rendered.length > 0) {
      return rendered
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)[0];
    }
  }

  const defect = cause.reasons.find(Cause.isDieReason);
  if (defect != null) {
    const rendered =
      defect.defect instanceof Error
        ? `${defect.defect.name}: ${defect.defect.message}`.trim()
        : String(defect.defect).trim();
    if (rendered.length > 0) {
      return rendered
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)[0];
    }
  }

  const pretty = Cause.pretty(cause).trim();
  if (pretty.length === 0) {
    return undefined;
  }
  return pretty
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)[0];
};

class ProgressTreeRenderer implements ProgressLoggerService {
  private readonly config: ProgressRenderConfig;
  private readonly nodes = new Map<string, ProgressNode>();
  private readonly roots = new Set<string>();
  private readonly rootOrder: Array<string> = [];
  private readonly interactive = process.stderr.isTTY === true;
  private readonly color = process.stderr.isTTY === true;
  private readonly output = this.interactive ? process.stderr : process.stdout;
  private frameIndex = 0;
  private sequence = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private cursorHidden = false;
  private renderedLineCount = 0;

  constructor(config: ProgressRenderConfig = defaultProgressRenderConfig) {
    this.config = config;
  }

  start(span: Tracer.Span, startTime: bigint) {
    const parentId = toParentId(span);
    const parent = parentId == null ? undefined : this.nodes.get(parentId);
    const node: ProgressNode = {
      spanId: span.spanId,
      parentId,
      name: span.name,
      span,
      children: [],
      depth: parent == null ? 0 : parent.depth + 1,
      status: "running",
      startedAt: startTime,
      endedAt: undefined,
      order: this.sequence++,
      failureSummary: undefined,
    };

    this.nodes.set(node.spanId, node);

    if (parent == null) {
      if (!this.roots.has(node.spanId)) {
        this.roots.add(node.spanId);
        this.rootOrder.push(node.spanId);
      }
    } else {
      parent.children.push(node.spanId);
    }

    if (this.interactive) {
      this.startTimer();
      this.renderFrame();
    } else {
      this.writePlain("start", node, startTime);
    }
  }

  end(span: Tracer.Span, endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
    const node = this.nodes.get(span.spanId);
    if (node == null) {
      return;
    }

    node.status = Exit.isSuccess(exit) ? "done" : isPureInterrupt(exit) ? "interrupted" : "failed";
    node.endedAt = endTime;
    node.failureSummary =
      node.status === "failed" && Exit.isFailure(exit) ? summarizeCause(exit.cause) : undefined;

    if (this.interactive) {
      if (this.hasActiveNodes()) {
        this.renderFrame();
      } else {
        this.flushFinalFrame();
      }
    } else {
      this.writePlain(node.status, node, endTime);
    }
  }

  close() {
    this.stopTimer();
    if (this.interactive) {
      this.clearFrame();
      this.showCursor();
    }
  }

  private hasActiveNodes(): boolean {
    return [...this.nodes.values()].some((node) => node.status === "running");
  }

  private hasRunningDescendant(node: ProgressNode): boolean {
    for (const childId of node.children) {
      const child = this.nodes.get(childId);
      if (child == null) {
        continue;
      }
      if (child.status === "running" || this.hasRunningDescendant(child)) {
        return true;
      }
    }
    return false;
  }

  private hasFailedDescendant(node: ProgressNode): boolean {
    for (const childId of node.children) {
      const child = this.nodes.get(childId);
      if (child == null) {
        continue;
      }
      if (child.status === "failed" || this.hasFailedDescendant(child)) {
        return true;
      }
    }
    return false;
  }

  private hasInterruptedDescendant(node: ProgressNode): boolean {
    for (const childId of node.children) {
      const child = this.nodes.get(childId);
      if (child == null) {
        continue;
      }
      if (child.status === "interrupted" || this.hasInterruptedDescendant(child)) {
        return true;
      }
    }
    return false;
  }

  private startTimer() {
    if (this.timer != null) {
      return;
    }
    if (this.interactive) {
      this.hideCursor();
    }
    this.timer = setInterval(() => {
      if (!this.hasActiveNodes()) {
        return;
      }
      this.frameIndex = (this.frameIndex + 1) % this.spinnerFrames.length;
      this.renderFrame();
    }, renderIntervalMs);
  }

  private get spinnerFrames(): ReadonlyArray<string> {
    return this.config.spinnerFrames != null && this.config.spinnerFrames.length > 0
      ? this.config.spinnerFrames
      : defaultSpinnerFrames;
  }

  private get headerLabel(): string {
    return this.config.headerLabel ?? defaultHeaderLabel;
  }

  private get symbols(): ProgressStatusSymbols {
    return {
      ...defaultStatusSymbols,
      ...this.config.symbols,
    };
  }

  private stopTimer() {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private findActiveNode(): ProgressNode | undefined {
    return [...this.nodes.values()]
      .filter((node) => node.status === "running")
      .sort((left, right) => {
        if (left.depth !== right.depth) {
          return right.depth - left.depth;
        }
        return right.order - left.order;
      })[0];
  }

  private renderFrame() {
    this.replaceFrame(this.buildViewportLines(false));
  }

  private flushFinalFrame() {
    const lines = this.buildViewportLines(true);
    this.stopTimer();
    this.replaceFrame(lines);
    this.renderedLineCount = 0;
    this.nodes.clear();
    this.roots.clear();
    this.rootOrder.length = 0;
    this.showCursor();
  }

  private buildViewportLines(final: boolean): Array<string> {
    const lines: Array<string> = [];
    const active = this.findActiveNode();
    const now = process.hrtime.bigint();
    const totalStarted = this.nodes.size;
    const totalRunning = [...this.nodes.values()].filter(
      (node) => node.status === "running",
    ).length;
    const totalFailed = [...this.nodes.values()].filter((node) => node.status === "failed").length;
    const totalInterrupted = [...this.nodes.values()].filter(
      (node) => node.status === "interrupted",
    ).length;
    const totalDone = totalStarted - totalRunning - totalFailed - totalInterrupted;
    const elapsedRoot = this.rootOrder
      .map((rootId) => this.nodes.get(rootId))
      .filter((node): node is ProgressNode => node != null)
      .map((node) => (node.endedAt ?? now) - node.startedAt)
      .sort((left, right) => Number(right - left))[0];
    const spinner = final
      ? totalFailed > 0
        ? this.symbols.failed
        : totalInterrupted > 0
          ? this.symbols.interrupted
          : this.symbols.success
      : (this.spinnerFrames[this.frameIndex] ?? "|");
    lines.push(
      [
        maybeColor(
          this.color,
          totalFailed > 0
            ? ansi.red
            : totalInterrupted > 0
              ? ansi.yellow
              : final
                ? ansi.green
                : ansi.cyan,
          spinner,
        ),
        " ",
        maybeColor(this.color, ansi.bold, this.headerLabel),
        maybeColor(
          this.color,
          ansi.dim,
          `  running=${totalRunning}  done=${totalDone}  failed=${totalFailed}  interrupted=${totalInterrupted}${elapsedRoot == null ? "" : `  elapsed=${formatDurationCompact(elapsedRoot)}`}`,
        ),
      ].join(""),
    );

    for (const rootId of this.rootOrder) {
      const root = this.nodes.get(rootId);
      if (root == null) {
        continue;
      }
      lines.push(...this.renderTreeNode(root, "", true, final, active, new Set<string>(), true));
    }

    if (active != null && !final) {
      const path = this.pathOf(active)
        .map((node) => formatSpanDisplayName(node.name, node.span, this.config, "interactive"))
        .join(" > ");
      lines.push(
        `${maybeColor(this.color, ansi.dim, "Active:")} ${maybeColor(this.color, ansi.bold, path)}`,
      );
    } else if (final) {
      lines.push(
        `${maybeColor(
          this.color,
          ansi.dim,
          totalFailed > 0
            ? "Active: command failed"
            : totalInterrupted > 0
              ? "Active: command interrupted"
              : "Active: command completed",
        )}`,
      );
    }

    return lines;
  }

  private replaceFrame(lines: ReadonlyArray<string>) {
    if (!this.interactive) {
      return;
    }
    if (this.renderedLineCount > 0) {
      moveCursor(this.output, 0, -this.renderedLineCount);
      cursorTo(this.output, 0);
    }
    clearScreenDown(this.output);
    if (lines.length > 0) {
      this.output.write(`${lines.join("\n")}\n`);
    }
    this.renderedLineCount = lines.length;
  }

  private clearFrame() {
    if (!this.interactive || this.renderedLineCount === 0) {
      return;
    }
    moveCursor(this.output, 0, -this.renderedLineCount);
    cursorTo(this.output, 0);
    clearScreenDown(this.output);
    this.renderedLineCount = 0;
  }

  private renderTreeNode(
    node: ProgressNode,
    prefix: string,
    isLast: boolean,
    final: boolean,
    active: ProgressNode | undefined,
    inheritedAttributes = new Set<string>(),
    isRoot = false,
  ): Array<string> {
    const branch = isRoot ? "" : isLast ? tree.lastBranch : tree.branch;
    const branchPrefix = isRoot ? "" : maybeColor(this.color, ansi.dim, `${prefix}${branch}`);
    const attributes = renderCompactAttributes(
      node.span.attributes,
      node.span,
      this.config,
      inheritedAttributes,
    );
    const lines = [`${branchPrefix}${this.renderNodeLabel(node, final, active, attributes.text)}`];
    if (
      node.status === "failed" &&
      node.failureSummary != null &&
      !this.hasFailedDescendant(node)
    ) {
      const detailIndent = isRoot ? prefix : prefix + (isLast ? tree.space : tree.vertical);
      lines.push(
        `${maybeColor(this.color, ansi.dim, detailIndent)}${maybeColor(this.color, ansi.red, detailPrefix)}${maybeColor(this.color, ansi.dim, node.failureSummary)}`,
      );
    }
    const shouldExpand =
      final ||
      node.status === "running" ||
      this.hasRunningDescendant(node) ||
      this.hasFailedDescendant(node) ||
      this.hasInterruptedDescendant(node) ||
      isRoot;
    if (!shouldExpand) {
      return lines;
    }

    const childPrefix = isRoot ? prefix : prefix + (isLast ? tree.space : tree.vertical);
    const nextInherited = new Set([...inheritedAttributes, ...attributes.visible]);
    const children = [...node.children]
      .map((childId) => this.nodes.get(childId))
      .filter((child): child is ProgressNode => child != null)
      .sort((left, right) => left.order - right.order);

    for (const [index, child] of children.entries()) {
      lines.push(
        ...this.renderTreeNode(
          child,
          childPrefix,
          index === children.length - 1,
          final,
          active,
          nextInherited,
        ),
      );
    }

    return lines;
  }

  private renderNodeLabel(
    node: ProgressNode,
    final: boolean,
    active: ProgressNode | undefined,
    attributes: string,
  ): string {
    if (node.status === "running") {
      const isActiveLeaf = active != null && node.spanId === active.spanId;
      const elapsed = formatDurationCompact(process.hrtime.bigint() - node.startedAt);
      if (isActiveLeaf) {
        const spinner = this.spinnerFrames[this.frameIndex] ?? "|";
        return `${maybeColor(this.color, ansi.cyan, spinner)} ${maybeColor(this.color, ansi.bold, formatSpanDisplayName(node.name, node.span, this.config, "interactive"))}${attributes}${maybeColor(this.color, ansi.dim, ` ${elapsed}`)}`;
      }

      return `${maybeColor(this.color, ansi.yellow, this.symbols.runningParent)} ${maybeColor(this.color, ansi.yellow, formatSpanDisplayName(node.name, node.span, this.config, "interactive"))}${attributes}${maybeColor(this.color, ansi.dim, ` ${elapsed}`)}`;
    }

    const duration =
      node.endedAt == null ? "" : ` ${formatDurationCompact(node.endedAt - node.startedAt)}`;
    const marker =
      node.status === "failed"
        ? this.symbols.failed
        : node.status === "interrupted"
          ? this.symbols.interrupted
          : this.symbols.success;
    const markerColor =
      node.status === "failed"
        ? ansi.red
        : node.status === "interrupted"
          ? ansi.yellow
          : ansi.green;
    const spanName = formatSpanDisplayName(node.name, node.span, this.config, "interactive");
    const name = final ? maybeColor(this.color, ansi.bold, spanName) : spanName;
    return `${maybeColor(this.color, markerColor, marker)} ${name}${attributes}${maybeColor(this.color, ansi.dim, duration)}`;
  }

  private hideCursor() {
    if (!this.interactive || this.cursorHidden) {
      return;
    }
    this.output.write(ansi.hideCursor);
    this.cursorHidden = true;
  }

  private showCursor() {
    if (!this.interactive || !this.cursorHidden) {
      return;
    }
    this.output.write(ansi.showCursor);
    this.cursorHidden = false;
  }

  private pathOf(node: ProgressNode): Array<ProgressNode> {
    const path: Array<ProgressNode> = [];
    let current: ProgressNode | undefined = node;
    while (current != null) {
      path.push(current);
      current = current.parentId == null ? undefined : this.nodes.get(current.parentId);
    }
    return path.reverse();
  }

  private writePlain(
    phase: "start" | "done" | "failed" | "interrupted",
    node: ProgressNode,
    time: bigint,
  ) {
    const indent = plainIndent.repeat(node.depth);
    const prefix =
      phase === "start"
        ? "[start]"
        : phase === "done"
          ? `[done ${formatDurationVerbose(time - node.startedAt)}]`
          : phase === "interrupted"
            ? `[interrupted ${formatDurationVerbose(time - node.startedAt)}]`
            : `[failed ${formatDurationVerbose(time - node.startedAt)}]`;
    this.output.write(
      `${indent}${prefix} ${formatSpanDisplayName(node.name, node.span, this.config, "raw")}${renderRawAttributesWithConfig(node.span.attributes, node.span, this.config)}\n`,
    );
  }
}

export class ProgressLogger extends ServiceMap.Service<ProgressLogger, ProgressLoggerService>()(
  "@git-agent/ProgressLogger",
) {}

export const ProgressLoggerLive = Layer.effect(
  ProgressLogger,
  Effect.acquireRelease(
    Effect.sync(() => new ProgressTreeRenderer()),
    (logger) => Effect.sync(() => logger.close()),
  ),
);

export const ProgressTracingLayer = Layer.effect(
  Tracer.Tracer,
  Effect.gen(function* () {
    const progressLogger = yield* ProgressLogger;
    const tracer = yield* Tracer.Tracer;

    return Tracer.make({
      span(options) {
        const span = tracer.span(options);
        progressLogger.start(span, options.startTime);
        const originalEnd = span.end;

        span.end = (endTime, exit) => {
          progressLogger.end(span, endTime, exit);
          return originalEnd.call(span, endTime, exit);
        };

        return span;
      },
    });
  }),
);

export const makeProgressLoggerLayer = (
  config: ProgressRenderConfig = defaultProgressRenderConfig,
) =>
  Layer.effect(
    ProgressLogger,
    Effect.acquireRelease(
      Effect.sync(() => new ProgressTreeRenderer(config)),
      (logger) => Effect.sync(() => logger.close()),
    ),
  );

export const makeProgressLayer = (config: ProgressRenderConfig = defaultProgressRenderConfig) =>
  ProgressTracingLayer.pipe(Layer.provide(makeProgressLoggerLayer(config)));

export const ProgressLayer = makeProgressLayer();
