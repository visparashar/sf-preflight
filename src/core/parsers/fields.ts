// SPDX-License-Identifier: Apache-2.0
import type { FieldDef } from "../types.js";
import { asArray, bool, nodes, parseMetadataXml, text, uniq } from "../util.js";
import { formulaFieldRefs } from "./formula.js";

/** Picklist values in some files are URL-encoded (`Closed%20Won`). */
export function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Parse `objects/<Object>/fields/<Field>.field-meta.xml`. */
export function parseField(xml: string, object: string, fallbackName: string, file: string): FieldDef {
  const { body } = parseMetadataXml(xml);
  const name = text(body.fullName) ?? fallbackName;
  const type = text(body.type);
  const formula = text(body.formula);
  const referenceTo = asArray(body.referenceTo as string | string[]).map(String);

  const field: FieldDef = {
    object,
    name,
    fullName: `${object}.${name}`,
    type,
    formula,
    formulaRefs: formula ? formulaFieldRefs(formula) : [],
    referenceTo,
    required: bool(body.required) || type === "MasterDetail" || undefined,
    defaultValue: text(body.defaultValue),
    cascadeDelete:
      type === "MasterDetail" || (type === "Lookup" && text(body.deleteConstraint) === "Cascade") || undefined,
    file,
  };

  const valueSet = body.valueSet as Record<string, unknown> | undefined;
  if (valueSet && typeof valueSet === "object") {
    const definition = valueSet.valueSetDefinition as Record<string, unknown> | undefined;
    const values = nodes(definition?.value).flatMap((v) => {
      const n = text(v.fullName);
      // Old API versions leave out <isActive>; a value is active unless it says otherwise.
      return n === undefined ? [] : [{ name: decode(n), active: v.isActive === undefined ? true : bool(v.isActive) }];
    });
    const valueSetName = text(valueSet.valueSetName);
    if (values.length || valueSetName) field.picklist = { values, ...(valueSetName ? { valueSetName } : {}) };
  }

  if (type === "Summary") {
    const foreignKey = text(body.summaryForeignKey) ?? "";
    const [childObject, relationshipField] = foreignKey.split(".");
    const summarized = text(body.summarizedField);
    if (childObject) {
      field.summary = {
        childObject,
        relationshipField: relationshipField ?? "",
        operation: text(body.summaryOperation),
        summarizedField: summarized,
        filterFields: uniq(
          nodes(body.summaryFilterItems)
            .map((f) => text(f.field))
            .filter((f): f is string => !!f),
        ),
      };
    }
  }

  return field;
}
