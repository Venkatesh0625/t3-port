/** A failure the user should see as a message, not a stack trace. */
export class PortError extends Error {
  static is(error: unknown): error is PortError {
    return error instanceof PortError;
  }
}

/** A transcript past the size the tool will read. Skipped rather than fatal. */
export class TooLarge extends Error {
  constructor(
    readonly path: string,
    readonly bytes: number,
  ) {
    super(`${path} is ${(bytes / 1048576).toFixed(0)} MB, past the read limit`);
  }
  static is(error: unknown): error is TooLarge {
    return error instanceof TooLarge;
  }
}
