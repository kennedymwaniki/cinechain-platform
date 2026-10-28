import { z } from 'zod';

export interface ZodDtoClass<S extends z.ZodType = z.ZodType> {
  new (): z.infer<S>;
  readonly schema: S;
}

type JsonSchema = Record<string, unknown> & { type?: unknown; anyOf?: JsonSchema[] };

/**
 * @nestjs/swagger treats a property with no `type` as a lazy class reference
 * and fails with "circular dependency". Zod emits `anyOf: [X, { type: 'null' }]`
 * for nullable fields and no `type` for unions, so normalise those.
 */
function toSwaggerProperty(v: JsonSchema): JsonSchema {
  if (v.type !== undefined) return v;
  const variants = v.anyOf ?? [];
  const nonNull = variants.filter((x) => x.type !== 'null');
  if (nonNull.length === 1 && variants.length === 2) {
    const { anyOf: _anyOf, ...rest } = v;
    return { ...rest, ...toSwaggerProperty(nonNull[0]!), nullable: true };
  }
  return { ...v, type: 'object' };
}

function isStrictObject(schema: z.ZodType): boolean {
  const def = (schema as unknown as { def: { type: string; catchall?: { def?: { type?: string } } } }).def;
  return def.type !== 'object' || def.catchall?.def?.type === 'never';
}

/**
 * A DTO class backed by a Zod schema: `class CreateTheatre extends
 * createZodDto(schema) {}`, then `@Body() body: CreateTheatre`. The global
 * ZodValidationPipe validates it, and Swagger reads its JSON Schema.
 *
 * Object schemas MUST be `.strict()`, enforced here at definition time: an
 * extra `tenant_id` key is then a 400, never a silently ignored field.
 */
export function createZodDto<S extends z.ZodType>(schema: S): ZodDtoClass<S> {
  if (!isStrictObject(schema)) throw new Error('createZodDto: object schemas must be .strict()');
  class ZodDto {
    static readonly schema = schema;
    /** Read by @nestjs/swagger to describe the body. */
    static _OPENAPI_METADATA_FACTORY() {
      const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as {
        properties?: Record<string, Record<string, unknown>>;
        required?: string[];
      };
      const required = new Set(json.required ?? []);
      return Object.fromEntries(
        Object.entries(json.properties ?? {}).map(([k, v]) => [k, { ...toSwaggerProperty(v), required: required.has(k) }]),
      );
    }
  }
  return ZodDto as unknown as ZodDtoClass<S>;
}
