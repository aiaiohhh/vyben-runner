export class RunnerError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = "RunnerError";
    }
}
export function toRunnerError(error) {
    if (error instanceof RunnerError)
        return error;
    if (error instanceof Error) {
        return new RunnerError("runner_failed", error.message, { cause: error });
    }
    return new RunnerError("runner_failed", "Runner failed with an unknown error");
}
