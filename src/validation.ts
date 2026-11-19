import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import Ajv2019 from 'ajv/dist/2019.js';
import type { JsonObject } from './types.js';

export class InputError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly param?: string,
  ) {
    super(message);
  }
}

export function object(value: unknown, label = 'Request'): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InputError(`${label} must be a JSON object`);
  return value;
}

export function validateArguments(schema: JsonObject, value: unknown) {
  object(value, 'Tool arguments');
  const options = { strict: false, allErrors: true, validateFormats: false };
  const version = String(schema.$schema ?? '');
  const validator = version.includes('2020-12')
    ? new Ajv2020.default(options)
    : version.includes('2019-09')
      ? new Ajv2019.default(options)
      : new Ajv.default(options);
  try {
    const validate = validator.compile(schema);
    if (!validate(value))
      throw new InputError(validator.errorsText(validate.errors, { separator: '; ' }));
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(
      `Cannot validate this tool schema: ${error instanceof Error ? error.message : error}`,
    );
  }
}
