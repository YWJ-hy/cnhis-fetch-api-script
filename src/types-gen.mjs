const EXCLUDED_PARAM_NAMES = ["map", "userRoleResource"];

const toPascalCase = value => {
  const cleaned = String(value).replace(/[{}]/g, "");
  const parts = cleaned.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!parts.length) return "";
  return parts.map(part => part[0].toUpperCase() + part.slice(1)).join("");
};

const isValidIdentifier = value => /^[A-Za-z_$][\w$]*$/.test(value);

const sanitizeComment = value =>
  String(value || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\*\//g, "");

const isLargeInteger = schema => {
  const format = String(schema?.format || "").toLowerCase();
  return format && format !== "int32";
};

const resolveRef = (swagger, ref) => {
  const prefix = "#/definitions/";
  const key = ref.startsWith(prefix) ? ref.slice(prefix.length) : ref.split("/").pop();
  if (!key) return null;
  const defs = swagger.definitions || swagger.components?.schemas || {};
  return defs[key] || null;
};

const mergeAllOf = (swagger, schema) => {
  if (!schema.allOf) return schema;
  const merged = { type: "object", properties: {}, required: [] };
  for (const item of schema.allOf) {
    const target = item.$ref ? resolveRef(swagger, item.$ref) || {} : item;
    if (target.properties) Object.assign(merged.properties, target.properties);
    if (Array.isArray(target.required)) {
      merged.required = Array.from(new Set([...(merged.required || []), ...target.required]));
    }
  }
  return merged;
};

const createTypeContext = () => ({
  order: [],
  defs: new Map(),
  usedNames: new Set(),
  anonId: 1,
  namespaces: new Map(),
});

const getNamespaceContext = (ctx, namespace) => {
  if (!ctx.namespaces.has(namespace)) {
    ctx.namespaces.set(namespace, {
      order: [],
      defs: new Map(),
      usedNames: new Set(),
      anonId: 1,
    });
  }
  return ctx.namespaces.get(namespace);
};

const uniqueName = (ctx, base) => {
  let name = base || `Anon${ctx.anonId++}`;
  let index = 2;
  while (ctx.usedNames.has(name)) {
    name = `${base}${index++}`;
  }
  ctx.usedNames.add(name);
  return name;
};

const defineType = (ctx, name, code, exported) => {
  if (ctx.defs.has(name)) {
    const existing = ctx.defs.get(name);
    if (exported && existing && !existing.exported) existing.exported = true;
    return;
  }
  ctx.defs.set(name, { code, exported: !!exported });
  ctx.order.push(name);
};

const schemaToType = (swagger, ctx, schema, nameHint, namespace, _visited) => {
  if (!schema) return "any";
  if (schema.$ref) {
    if (_visited?.has(schema.$ref)) return "any";
    const visited = new Set(_visited);
    visited.add(schema.$ref);
    const resolved = resolveRef(swagger, schema.$ref);
    if (resolved) {
      return schemaToType(
        swagger,
        ctx,
        resolved,
        nameHint || schema.$ref.split("/").pop(),
        namespace,
        visited,
      );
    }
  }
  if (schema.oneOf || schema.anyOf) {
    const list = schema.oneOf || schema.anyOf || [];
    const types = list.map(item => schemaToType(swagger, ctx, item, nameHint, namespace, _visited));
    return types.length ? types.join(" | ") : "any";
  }
  if (schema.allOf) {
    return schemaToType(swagger, ctx, mergeAllOf(swagger, schema), nameHint, namespace, _visited);
  }
  const type = schema.type;
  if (type === "array" || schema.items) {
    const itemType = schemaToType(
      swagger,
      ctx,
      schema.items,
      `${nameHint || "Item"}Item`,
      namespace,
      _visited,
    );
    return `${itemType}[]`;
  }
  if (type === "object" || schema.properties || schema.additionalProperties) {
    if (type === "object" && !schema.properties && !schema.additionalProperties)
      return "ObjectType";
    if (schema.additionalProperties && !schema.properties) {
      const valueType = schemaToType(
        swagger,
        ctx,
        schema.additionalProperties,
        `${nameHint || "Value"}Value`,
        namespace,
        _visited,
      );
      return `Record<string, ${valueType}>`;
    }
    const targetCtx = namespace ? getNamespaceContext(ctx, namespace) : ctx;
    const name = uniqueName(targetCtx, toPascalCase(nameHint || `Anon${targetCtx.anonId++}`));
    const props = schema.properties || {};
    const required = new Set(schema.required || []);
    const lines = Object.keys(props).map(propName => {
      const propSchema = props[propName] || {};
      const optional = !required.has(propName);
      const propType = schemaToType(swagger, ctx, propSchema, propName, namespace, _visited);
      const outputType = optional ? `Nullable<${propType}>` : propType;
      const key = isValidIdentifier(propName) ? propName : JSON.stringify(propName);
      const comment = propSchema.description
        ? ` // ${sanitizeComment(propSchema.description)}`
        : "";
      return `  ${key}${optional ? "?" : ""}: ${outputType};${comment}`;
    });
    const code = `interface ${name} {\n${lines.join("\n")}\n}`;
    defineType(targetCtx, name, code, false);
    return namespace ? `${namespace}.${name}` : name;
  }
  if (schema.enum && Array.isArray(schema.enum)) {
    const types = schema.enum.map(item => JSON.stringify(item));
    return types.length ? types.join(" | ") : "any";
  }
  if (type === "integer") return isLargeInteger(schema) ? "string" : "number";
  if (type === "number") return "number";
  if (type === "boolean") return "boolean";
  if (type === "string") return "string";
  return "any";
};

const createNamedType = (swagger, ctx, schema, name, exported, namespaceForChildren, _visited) => {
  if (!schema) {
    defineType(ctx, name, `type ${name} = any;`, exported);
    return name;
  }
  if (schema.$ref) {
    if (_visited?.has(schema.$ref)) {
      defineType(ctx, name, `type ${name} = any;`, exported);
      return name;
    }
    const visited = new Set(_visited);
    visited.add(schema.$ref);
    const resolved = resolveRef(swagger, schema.$ref);
    if (resolved)
      return createNamedType(swagger, ctx, resolved, name, exported, namespaceForChildren, visited);
  }
  if (schema.allOf) {
    return createNamedType(
      swagger,
      ctx,
      mergeAllOf(swagger, schema),
      name,
      exported,
      namespaceForChildren,
      _visited,
    );
  }
  const type = schema.type;
  if (type === "object" || schema.properties || schema.additionalProperties) {
    if (type === "object" && !schema.properties && !schema.additionalProperties) {
      defineType(ctx, name, `type ${name} = ObjectType;`, exported);
      return name;
    }
    if (schema.additionalProperties && !schema.properties) {
      const valueType = schemaToType(
        swagger,
        ctx,
        schema.additionalProperties,
        `${name}Value`,
        namespaceForChildren,
        _visited,
      );
      defineType(ctx, name, `type ${name} = Record<string, ${valueType}>;`, exported);
      return name;
    }
    const props = schema.properties || {};
    const required = new Set(schema.required || []);
    const lines = Object.keys(props).map(propName => {
      const propSchema = props[propName] || {};
      const optional = !required.has(propName);
      const propType = schemaToType(
        swagger,
        ctx,
        propSchema,
        propName,
        namespaceForChildren,
        _visited,
      );
      const outputType = optional ? `Nullable<${propType}>` : propType;
      const key = isValidIdentifier(propName) ? propName : JSON.stringify(propName);
      const comment = propSchema.description
        ? ` // ${sanitizeComment(propSchema.description)}`
        : "";
      return `  ${key}${optional ? "?" : ""}: ${outputType};${comment}`;
    });
    const code = `interface ${name} {\n${lines.join("\n")}\n}`;
    defineType(ctx, name, code, exported);
    return name;
  }
  if (type === "array" || schema.items) {
    const itemType = schemaToType(
      swagger,
      ctx,
      schema.items,
      `${name}Item`,
      namespaceForChildren,
      _visited,
    );
    defineType(ctx, name, `type ${name} = ${itemType}[];`, exported);
    return name;
  }
  if (schema.enum && Array.isArray(schema.enum)) {
    const types = schema.enum.map(item => JSON.stringify(item));
    defineType(ctx, name, `type ${name} = ${types.length ? types.join(" | ") : "any"};`, exported);
    return name;
  }
  if (type) {
    const basic = type === "integer" ? (isLargeInteger(schema) ? "string" : "number") : type;
    defineType(ctx, name, `type ${name} = ${basic};`, exported);
    return name;
  }
  defineType(ctx, name, `type ${name} = any;`, exported);
  return name;
};

const pickResponseSchema = (responses = {}) => {
  const res =
    responses["200"] || responses["201"] || responses[Object.keys(responses)[0] || ""] || null;
  if (!res) return null;
  if (res.schema) return res.schema;
  if (res.content && typeof res.content === "object") {
    const content =
      res.content["application/json"] ||
      res.content["application/*+json"] ||
      res.content[Object.keys(res.content)[0] || ""];
    return content?.schema || null;
  }
  return null;
};

const sanitizeParamSchema = (swagger, schema, _visited) => {
  if (!schema) return schema;
  if (schema.$ref) {
    const visited = _visited || new Set();
    if (visited.has(schema.$ref)) return schema;
    visited.add(schema.$ref);
    const resolved = resolveRef(swagger, schema.$ref);
    if (!resolved) return schema;
    return sanitizeParamSchema(swagger, resolved, visited);
  }
  if (schema.allOf) {
    return sanitizeParamSchema(swagger, mergeAllOf(swagger, schema), _visited);
  }
  if (schema.type === "object" || schema.properties) {
    const next = { ...schema };
    if (next.properties) {
      next.properties = { ...next.properties };
      EXCLUDED_PARAM_NAMES.forEach(name => {
        if (name in next.properties) delete next.properties[name];
      });
    }
    if (Array.isArray(next.required)) {
      next.required = next.required.filter(name => !EXCLUDED_PARAM_NAMES.includes(name));
    }
    return next;
  }
  return schema;
};

const buildParamsSchema = (swagger, parameters = []) => {
  const bodyParam = parameters.find(item => item.in === "body");
  if (bodyParam?.schema) return sanitizeParamSchema(swagger, bodyParam.schema);
  const queryParams = parameters.filter(
    item =>
      (item.in === "query" || item.in === "formData") && !EXCLUDED_PARAM_NAMES.includes(item.name),
  );
  if (!queryParams.length) return null;
  const properties = {};
  const required = [];
  queryParams.forEach(param => {
    const schema = param.schema || {
      type: param.type,
      items: param.items,
      enum: param.enum,
      format: param.format,
    };
    properties[param.name] = { ...schema, description: param.description };
    if (param.required) required.push(param.name);
  });
  return sanitizeParamSchema(swagger, { type: "object", properties, required });
};

const extractDataSchema = (schema, swagger, _visited) => {
  if (!schema) return null;
  if (schema.$ref) {
    const visited = _visited || new Set();
    if (visited.has(schema.$ref)) return schema;
    visited.add(schema.$ref);
    const resolved = resolveRef(swagger, schema.$ref);
    if (resolved) return extractDataSchema(resolved, swagger, visited);
  }
  if (schema.allOf) return extractDataSchema(mergeAllOf(swagger, schema), swagger, _visited);
  const properties = schema.properties || {};
  if (properties.data) return properties.data;
  const wrapperKeys = ["code", "data", "errorData", "msg", "subErrors", "success"];
  const keys = Object.keys(properties);
  if (keys.length && keys.some(key => wrapperKeys.includes(key))) return { type: "object" };
  return schema;
};

export {
  EXCLUDED_PARAM_NAMES,
  toPascalCase,
  isValidIdentifier,
  sanitizeComment,
  isLargeInteger,
  resolveRef,
  mergeAllOf,
  createTypeContext,
  getNamespaceContext,
  uniqueName,
  defineType,
  schemaToType,
  createNamedType,
  pickResponseSchema,
  sanitizeParamSchema,
  buildParamsSchema,
  extractDataSchema,
};
