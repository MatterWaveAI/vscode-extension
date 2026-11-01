/**
 * `template` with each `{name}` that `values` has replaced, literally and in
 * one pass, so a brace in a value stays as it is; a `{name}` it does not have
 * is left alone.
 */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    if (template[i] === "{") {
      const end = template.indexOf("}", i);
      const key = end !== -1 ? template.slice(i + 1, end) : "";
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        out += values[key];
        i = end + 1;
        continue;
      }
    }
    out += template[i];
    i += 1;
  }
  return out;
}
