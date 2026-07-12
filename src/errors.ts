export class RunnerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RunnerError";
  }
}

export function toRunnerError(error: unknown): RunnerError {
  if (error instanceof RunnerError) return error;
  if (error instanceof Error) {
    return new RunnerError("runner_failed", error.message, { cause: error });
  }
  return new RunnerError(
    "runner_failed",
    "Runner failed with an unknown error",
  );
}
