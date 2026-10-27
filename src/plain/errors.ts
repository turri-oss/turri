/** Ports of the exception classes of the Python reference implementation that this parser raises. */

export class PlainSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlainSyntaxError";
  }
}

export class UnsupportedBase64Content extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedBase64Content";
  }
}

export class ModuleDoesNotExistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModuleDoesNotExistError";
  }
}

export class MissingFunctionalitiesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingFunctionalitiesError";
  }
}

export class ImportedModuleWithFunctionalitiesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportedModuleWithFunctionalitiesError";
  }
}

/** A functional spec of the chain has no test plain file bound to it. */
export class MissingTestPlainFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingTestPlainFileError";
  }
}

export class InvalidFridArgument extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFridArgument";
  }
}

export class InvalidLiquidVariableName extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLiquidVariableName";
  }
}
