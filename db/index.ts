import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

const sql = neon(process.env.DATABASE_URL!);

export const db = drizzle(sql, { schema });

/**
 * The control-plane database — platform + tenant identity, config, auth, and
 * coordination (A1). Alias of `db`. Content (the data plane) resolves per
 * project via lib/data-plane's tenantDb, which falls back to this DB for
 * projects with no neon connector (dev/test/free).
 */
export const controlDb = db;

export { schema };
