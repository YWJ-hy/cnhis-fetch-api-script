import assert from "node:assert/strict";
import test from "node:test";
import { createNamedType, createTypeContext } from "../src/types-gen.mjs";

const getGeneratedCode = (ctx, namespace) => {
  const globalCode = ctx.order.map(name => ctx.defs.get(name)?.code).filter(Boolean);
  const namespaceCtx = ctx.namespaces.get(namespace);
  const namespaceCode = namespaceCtx
    ? namespaceCtx.order.map(name => namespaceCtx.defs.get(name)?.code).filter(Boolean)
    : [];
  return [...globalCode, ...namespaceCode].join("\n\n");
};

test("stops expanding a recursive array reference", () => {
  const swagger = {
    definitions: {
      TreeNode: {
        type: "object",
        properties: {
          name: { type: "string" },
          children: {
            type: "array",
            items: { $ref: "#/definitions/TreeNode" },
          },
        },
      },
    },
  };
  const ctx = createTypeContext();

  createNamedType(
    swagger,
    ctx,
    { type: "array", items: { $ref: "#/definitions/TreeNode" } },
    "TreeResult",
    true,
    "TreeResult",
  );

  const code = getGeneratedCode(ctx, "TreeResult");
  assert.match(code, /type TreeResult = TreeResult\.TreeResultItem\[\];/);
  assert.match(code, /children\?: Nullable<any\[\]>;/);
});

test("tracks references per branch instead of across sibling properties", () => {
  const swagger = {
    definitions: {
      Parent: {
        type: "object",
        properties: {
          first: { $ref: "#/definitions/Child" },
          second: { $ref: "#/definitions/Child" },
        },
      },
      Child: {
        type: "object",
        properties: {
          value: { type: "string" },
        },
      },
    },
  };
  const ctx = createTypeContext();

  createNamedType(
    swagger,
    ctx,
    { $ref: "#/definitions/Parent" },
    "ParentResult",
    true,
    "ParentResult",
  );

  const code = getGeneratedCode(ctx, "ParentResult");
  assert.match(code, /first\?: Nullable<ParentResult\.First>;/);
  assert.match(code, /second\?: Nullable<ParentResult\.Second>;/);
  assert.match(code, /interface First \{\n  value\?: Nullable<string>;/);
  assert.match(code, /interface Second \{\n  value\?: Nullable<string>;/);
});
