import type { TypedSchema, TypedSchemaError } from "vee-validate";
import type { z } from "zod";

// @vee-validate/zod only supports Zod 3, so this adapts a Zod 4 schema to VeeValidate's TypedSchema.
export function toTypedSchema<T extends z.ZodType>(schema: T): TypedSchema<z.input<T>, z.output<T>> {
  return {
    __type: "VVTypedSchema",
    async parse(values) {
      const result = await schema.safeParseAsync(values);
      if (result.success) return { value: result.data, errors: [] };

      const byPath = new Map<string, string[]>();
      for (const issue of result.error.issues) {
        const path = issue.path.join(".");
        byPath.set(path, [...(byPath.get(path) ?? []), issue.message]);
      }
      const errors: TypedSchemaError[] = [...byPath].map(([path, errors]) => ({ path, errors }));
      return { errors };
    },
  };
}
