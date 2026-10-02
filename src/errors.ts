/** Message of anything thrown or failed with: typed errors, plain Errors, or values. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
