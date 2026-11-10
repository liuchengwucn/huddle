export class HuddleError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = "HuddleError";
  }
}

/** The transport repo is visible to others but the config does not allow that. */
export class PublicRepoError extends HuddleError {
  constructor(message: string) {
    super(message);
    this.name = "PublicRepoError";
  }
}
