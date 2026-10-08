export class FencepointError extends Error {
  constructor(message: string, readonly details: Readonly<Record<string, string | number>> = {}) {
    super(message);
    this.name = new.target.name;
    Object.freeze(details);
  }
}

export class CanonicalizationError extends FencepointError {}
export class FenceConflictError extends FencepointError {}
export class LeaseExpiredError extends FencepointError {}
export class PayloadConflictError extends FencepointError {}
export class AlreadyAdmittedError extends FencepointError {}
export class InvalidTransitionError extends FencepointError {}
export class EffectAlreadyTerminalError extends FencepointError {}
export class StorageError extends FencepointError {}
