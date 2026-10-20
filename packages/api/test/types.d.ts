import "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    adminConnectionString: string;
    templateDatabase: string;
    applicationPassword: string;
    migrationPassword: string;
  }
}
