import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migration = new URL(
  "../../../../../supabase/migrations/20260914000700_fix_project_workspace_space_alias_scope.sql",
  import.meta.url,
);

describe("workspace projection PostgreSQL compatibility migration", () => {
  it("gives both JSON array result sets an explicit value column", async () => {
    const sql = await readFile(migration, "utf8");
    const functionBody = sql.slice(
      sql.indexOf("create or replace function conuo_private.project_workspace"),
      sql.indexOf("revoke all on function conuo_private.project_workspace"),
    );

    expect(
      functionBody.match(/jsonb_array_elements\(p_data->'spaces'\) as sp\(value\)/g),
    ).toHaveLength(2);
    expect(functionBody).toContain("sp.value->>'id'");
    expect(functionBody).toContain("sp.value->'archived'");
    expect(functionBody).not.toMatch(/\bsp->/);
  });
});
