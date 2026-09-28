/** A failure the user should see as a message, not a stack trace. */
export class PortError extends Error {
  static is(error: unknown): error is PortError {
    return error instanceof PortError;
  }
}
