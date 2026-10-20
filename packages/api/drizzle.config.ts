import { defineConfig } from "drizzle-kit";

const url = process.env.MIGRATION_DATABASE_URL;

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  ...(url ? { dbCredentials: { url } } : {}),
});
